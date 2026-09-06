"""Render animated README previews from this checkout's actual Three.js app.

Python: Playwright + Pillow. System: FFmpeg and a WebGL2-capable Chromium.
On the Linux reference environment, run under xvfb-run. No stock/generated
imagery or replacement renderer is used. The GIF rate is an offline output rate.
"""
from __future__ import annotations

import argparse
import ast
import hashlib
import json
import math
import os
from pathlib import Path
import shutil
import subprocess
import time

from PIL import Image
from playwright.sync_api import sync_playwright

ROOT = Path(__file__).resolve().parents[1]
MEDIA = ROOT / "docs" / "media"
WORK = ROOT / "capture" / "preview-work"
WIDTH, HEIGHT, FPS = 640, 360, 10
PREVIEWS = {
    "dawn-swells": (0, 2.0, 4.0),
    "whitewater": (2, 2.0, 4.0),
    "heavy-seas": (3, 2.0, 4.0),
    "free-zoom": (4, 0.0, 10.0),
}


def sha256(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def run(command: list[str]) -> None:
    subprocess.run(command, check=True, timeout=180)


def film_shots() -> list[dict]:
    """Read the existing film definition without executing its capture module."""
    tree = ast.parse((ROOT / "capture" / "render.py").read_text())
    for item in tree.body:
        if isinstance(item, ast.Assign) and any(
            isinstance(target, ast.Name) and target.id == "SHOTS" for target in item.targets
        ):
            return ast.literal_eval(item.value)
    raise RuntimeError("The original SHOTS definition was not found")


def verify_gif(path: Path, frames: int, seconds: float) -> dict:
    with Image.open(path) as image:
        if image.format != "GIF" or not image.is_animated:
            raise RuntimeError(f"Not an animated GIF: {path}")
        if image.size != (WIDTH, HEIGHT) or image.n_frames != frames:
            raise RuntimeError(f"Wrong GIF dimensions or frame count: {path}")
        duration = 0
        hashes = []
        for index in range(image.n_frames):
            image.seek(index)
            duration += image.info.get("duration", 0)
            hashes.append(hashlib.sha256(image.convert("RGB").tobytes()).hexdigest())
        if len(set(hashes)) < max(2, frames // 2):
            raise RuntimeError(f"Too many identical frames: {path}")
        if abs(duration / 1000 - seconds) > 0.12:
            raise RuntimeError(f"Unexpected GIF duration: {duration}")
    return {"width": WIDTH, "height": HEIGHT, "frames": frames,
            "durationSeconds": duration / 1000, "bytes": path.stat().st_size,
            "sha256": sha256(path), "distinctDecodedFrames": len(set(hashes))}


def capture(name: str, quick: bool = False) -> dict:
    shot_index, offset, seconds = PREVIEWS[name]
    shot = film_shots()[shot_index]
    if quick:
        seconds = 0.5
    frames = round(seconds * FPS)
    MEDIA.mkdir(parents=True, exist_ok=True)
    WORK.mkdir(parents=True, exist_ok=True)
    html_path = ROOT / "public" / "standalone.html"
    if not html_path.exists():
        raise RuntimeError("Run python3 tools/build.py before capturing previews")
    if not shutil.which("ffmpeg"):
        raise RuntimeError("FFmpeg must be installed on PATH")
    movie = WORK / f"{name}.mp4"
    gif = MEDIA / f"{name}.gif"
    errors: list[str] = []
    warnings: list[str] = []
    frame_hashes: list[str] = []
    camera_samples: list[dict] = []
    started = time.monotonic()
    with sync_playwright() as playwright:
        executable = (os.environ.get("CHROMIUM_EXECUTABLE")
                      or shutil.which("chromium") or shutil.which("google-chrome"))
        options = {
            "headless": True,
            "args": ["--no-sandbox", "--disable-dev-shm-usage", "--use-gl=angle",
                     "--use-angle=gl", "--ignore-gpu-blocklist", "--enable-unsafe-swiftshader"],
            "env": {**os.environ, "LIBGL_ALWAYS_SOFTWARE": "1", "LP_NUM_THREADS": "3"},
        }
        if executable:
            options["executable_path"] = executable
        browser = playwright.chromium.launch(**options)
        try:
            page = browser.new_page(viewport={"width": WIDTH, "height": HEIGHT}, device_scale_factor=1)
            page.set_default_timeout(240000)
            page.on("pageerror", lambda error: errors.append(str(error)))
            page.on("console", lambda message: errors.append(message.text) if message.type == "error"
                    else warnings.append(message.text) if message.type == "warning" else None)
            query = f"?capture=1&width={WIDTH}&height={HEIGHT}&grid=256&scene={shot['scene']}"
            page.evaluate("q=>{window.__QUERY__=q}", query)
            page.set_content(html_path.read_text(), wait_until="domcontentloaded", timeout=240000)
            page.wait_for_function("window.__READY__ || window.__ERROR__", timeout=240000)
            if page.evaluate("window.__ERROR__") or errors:
                raise RuntimeError({"initialization": page.evaluate("window.__ERROR__"), "errors": errors})
            page.evaluate("s=>{app.setPreset(s);app.engine.post.reset()}", shot["scene"])
            native = page.evaluate("({width:app.engine.renderer.domElement.width,height:app.engine.renderer.domElement.height})")
            if native != {"width": WIDTH, "height": HEIGHT}:
                raise RuntimeError(f"Capture is not native resolution: {native}")
            renderer = page.evaluate("app.diagnostics().renderer")
            page.evaluate("""zoom=>{
                document.querySelector('.film-label').style.display=zoom?'block':'none';
                document.querySelector('.title-shadow').style.display=zoom?'block':'none';
                if(zoom){
                    app.label('Ocean to horizon','', 'AQUA / CYBR WATER 2.4');
                    document.querySelector('.film-label h2').style.fontSize='21px';
                    document.querySelector('.film-label p').style.fontSize='12px';
                    document.querySelector('.film-label .num').style.fontSize='9px';
                }
            }""", bool(shot.get("zoom")))
            # Step the original fixed-rate simulation up to the excerpt start.
            page.evaluate("n=>{for(let i=0;i<n;i++)app.engine.advance(1/24)}", round(offset * 24))
            command = ["ffmpeg", "-y", "-hide_banner", "-loglevel", "error", "-f", "image2pipe",
                       "-vcodec", "mjpeg", "-framerate", str(FPS), "-i", "pipe:0", "-an", "-c:v",
                       "libx264", "-preset", "fast", "-crf", "17", "-threads", "2", "-pix_fmt", "yuv420p",
                       "-vf", "pad=ceil(iw/2)*2:ceil(ih/2)*2", "-movflags", "+faststart", str(movie)]
            with (WORK / f"{name}-encoder.log").open("w") as log:
                encoder = subprocess.Popen(command, stdin=subprocess.PIPE, stderr=log)
                try:
                    for frame in range(frames):
                        # Use six exact 60 Hz ticks per 10 Hz preview frame.
                        t = offset + (frame + 1) / FPS
                        u = min(1.0, t / (shot["seconds"] - 1 / 24))
                        state = page.evaluate("""s=>{
                            for(let step=0;step<6;step++)app.engine.advance(1/60);
                            if(s.zoom){
                                const a=Math.sin(Math.PI*s.u)**2;
                                const distance=72*Math.exp(Math.log(20000/72)*a);
                                app.setOrbit({distance,pitch:.70,yaw:.52+s.u*.12,target:[0,0,0]});
                                document.querySelector('#shot-caption').textContent=
                                  (distance>=1000?(distance/1000).toFixed(2)+' km':distance.toFixed(0)+' m')+
                                  '  /  no application distance cap';
                            }else{
                                const mix=(a,b)=>a.map((v,i)=>v+(b[i]-v)*s.u);
                                app.setCamera({eye:mix(s.eye,s.end),target:mix(s.target,s.targetEnd),fov:s.fov});
                            }
                            app.render();
                            return {tick:app.engine.tick,camera:app.engine.currentCamera};
                        }""", {**shot, "u": u})
                        if errors:
                            raise RuntimeError(errors)
                        data = page.screenshot(type="jpeg", quality=96, animations="disabled")
                        if encoder.stdin is None:
                            raise RuntimeError("The encoder input pipe was not created")
                        encoder.stdin.write(data)
                        frame_hashes.append(hashlib.sha256(data).hexdigest())
                        if frame in (0, frames // 2, frames - 1):
                            camera_samples.append(state)
                        if frame == frames // 2:
                            (MEDIA / f"{name}.jpg").write_bytes(data)
                        if frame % 24 == 0:
                            print(name, frame, "/", frames, flush=True)
                    encoder.stdin.close()
                    if encoder.wait(timeout=120) != 0:
                        raise RuntimeError(f"Video encoding failed; see {name}-encoder.log")
                except BaseException:
                    encoder.kill()
                    encoder.wait(timeout=30)
                    raise
        finally:
            browser.close()
    # Preserve the native preview dimensions; palette encoding does not upscale.
    filter_graph = (f"[0:v]format=rgb24,crop={WIDTH}:{HEIGHT}:0:0,split[a][b];"
                    "[a]palettegen=max_colors=128:stats_mode=full[p];"
                    "[b][p]paletteuse=dither=bayer:bayer_scale=5:diff_mode=rectangle")
    run(["ffmpeg", "-y", "-hide_banner", "-loglevel", "error", "-threads", "2", "-i", str(movie),
         "-filter_complex", filter_graph, "-filter_complex_threads", "1", "-loop", "0", str(gif)])
    report = {"name": name, "file": f"docs/media/{name}.gif", "shot": shot,
              "excerptOffsetSeconds": offset, "outputFPS": FPS, "offlineRender": True,
              "renderer": renderer, "renderSeconds": time.monotonic() - started,
              "sourceBundleSHA256": sha256(ROOT / "public" / "engine-bundle.js"),
              "sourceHTMLSHA256": sha256(html_path), "capturedFrameSHA256": frame_hashes,
              "cameraSamples": camera_samples, "browserErrors": errors, "browserWarnings": warnings,
              "gif": verify_gif(gif, frames, seconds)}
    (MEDIA / f"{name}.json").write_text(json.dumps(report, indent=2) + "\n")
    print(json.dumps({"name": name, "gif": report["gif"], "secondsToRender": report["renderSeconds"]}), flush=True)
    return report


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--shot", choices=tuple(PREVIEWS))
    parser.add_argument("--quick-check", action="store_true", help="Half-second development check; not a finished preview")
    args = parser.parse_args()
    for name in ([args.shot] if args.shot else PREVIEWS):
        capture(name, quick=args.quick_check)
    # A matrix job may contain one report. The assembly job checks completeness.
    reports = [json.loads((MEDIA / f"{name}.json").read_text()) for name in PREVIEWS if (MEDIA / f"{name}.json").exists()]
    (MEDIA / "manifest.json").write_text(json.dumps({"kind": "actual-renderer-gif-captures", "reports": reports}, indent=2) + "\n")


if __name__ == "__main__":
    main()
