"""Package the exact captured build, complete source, and measured checks."""
from pathlib import Path
from zipfile import ZipFile, ZIP_DEFLATED
import json, hashlib, shutil

root=Path(__file__).resolve().parents[1]
delivery=root/'delivery';delivery.mkdir(exist_ok=True)
video=json.loads((root/'docs/video-validation.json').read_text())
html=root/'public/standalone.html'
sha=lambda p:hashlib.sha256(p.read_bytes()).hexdigest()
assert sha(html)==video['sourceHTMLSHA256']
assert video['fullDecodePassed'] and video['frames']==1008
browser=json.loads((root/'docs/browser-checks24.json').read_text())
assert browser['passed'] and not browser['browserErrors']
assert browser['sourceHTMLSHA256']==video['sourceHTMLSHA256']

(root/'docs/RELEASE-VALIDATION.md').write_text(f'''# CYBR WATER 2.4 — measured release checks

## Delivered film

{video['durationSeconds']:.0f} seconds; {video['frames']} newly rendered frames; native 1920 × 1080; 24 fps playback. Five independently rendered takes. Full ffmpeg decoding passed. No scaling, frame interpolation, or earlier footage was used. A smaller viewing encode and the original high-bitrate master are both delivered. The application delivered alongside the film has the exact HTML hash recorded by the capture process.

The film's zoom take goes from 72 m to approximately 20 km and back. The app's fixed upper zoom clamp was removed; independent camera checks reach 1,000 km. These distances describe orbit-camera range over a periodic plane, not a distinct kilometre-scale volumetric fluid simulation.

## Numerical tests

35 implementation checks pass (`tests.tap`). The independent NumPy audit samples 80,000 points at each of four times for five wave presets: 1.6 million composed-surface checks. No negative horizontal Jacobian was found in those samples (`wave-audit.json`). The audit is sampled, not a proof of safety at all times/locations/presets.

## Browser / GPU checks

The touch-enabled portrait Chromium context passed actual wheel and two-finger pinch input checks. The requested 500 m, 5 km, 100 km, and 1,000 km camera distances matched the resulting eye distances, with finite adaptive clip planes and no application upper cap. These were software-GPU checks, not tests of a physical Android phone.

The 128² GPU wave fields were compared with the CPU FFT reference, including displacements, derivatives, and velocity channels. The largest recorded channel difference was approximately 2.49×10⁻⁵ in that channel's units. This is an implementation comparison, not measured ocean-data agreement.

Under a flat zero-energy surface, the new whitewater field stayed [density=0, age=0, recent-aeration=0, Jacobian=1] everywhere in the tested map. A uniform seeded field matched exponential density/aeration decay and age increase to half-float precision, with no map-edge discontinuity in this constant-field check.

The shading-normal regression test renders an orientation mask for a fixed above-water close-up. The rejected sign-flip path produced 9,629 incorrectly downward-facing pixels in the 390 × 780 mask; the corrected geometric-normal path produced zero in that same test.

All five captured takes completed without browser console errors. Per-frame hashes and selected camera states are in `capture/output/*.json` in the source package.

## Provenance

Renderer: {browser['renderer']}.

HTML SHA256: `{video['sourceHTMLSHA256']}`

Video SHA256: `{video['movieSHA256']}`

The film was rendered offline. Playback frame rate does not demonstrate real-time rendering speed. The model remains a spectral ocean with modeled secondary whitewater and a local depth-averaged interaction field; see `LIMITATIONS.md`.
''')

files=[]
for folder in ['source','public/assets']:
 files.extend(p for p in (root/folder).rglob('*') if p.is_file())
files.extend(root/p for p in ['public/index.html','public/vendor.js','public/engine-bundle.js',
 'README.md','LIMITATIONS.md','ATTRIBUTION.md','LICENSE','THREE-LICENSE.txt','requirements.txt',
 'tools/build.py','tools/tests.cjs','tools/spectrum_audit.cjs','tools/wave_audit.py','tools/browser_checks.py',
 'tools/package.py','capture/render.py','capture/assemble.py'])
files.extend(p for p in (root/'capture/output').glob('*.json'))
files.append(root/'.gitignore')
files.extend(root/'docs'/name for name in ['tests.tap','wave-audit.json','sea-systems.json','browser-checks24.json','video-validation.json','RELEASE-VALIDATION.md'])
files=[p for p in files if p.name!='bootstrap.txt']
manifest={p.relative_to(root).as_posix():sha(p) for p in sorted(files)}
manifest['public/standalone.html']=sha(html)
(root/'RELEASE-HASHES.json').write_text(json.dumps(manifest,indent=2))
files.append(root/'RELEASE-HASHES.json')
archive=delivery/'CYBR-WATER-2.4-Source.zip'
with ZipFile(archive,'w',ZIP_DEFLATED,compresslevel=6) as z:
 for p in sorted(files):z.write(p,'CYBR-WATER-2.4/'+p.relative_to(root).as_posix())
shutil.copyfile(html,delivery/'CYBR-WATER-2.4.html')
checks=delivery/'CYBR-WATER-2.4-Checks.zip'
with ZipFile(checks,'w',ZIP_DEFLATED,compresslevel=6) as z:
 for name in ['tests.tap','wave-audit.json','sea-systems.json','browser-checks24.json','video-validation.json','RELEASE-VALIDATION.md']:
  z.write(root/'docs'/name,name)
for p in delivery.iterdir():
 if p.suffix in ['.mp4','.html','.zip']:
  target=Path('/mnt/data')/p.name
  # When run locally outside the supplied workspace, keep delivery local.
  if root.parent==Path('/mnt/data'):
   shutil.copyfile(p,target)
  print(p.name,p.stat().st_size,'bytes')
print('PACKAGING COMPLETE')
