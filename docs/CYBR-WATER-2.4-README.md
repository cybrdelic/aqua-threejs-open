# CYBR WATER 2.4 — waves, whitewater, and free-distance zoom

This is the edited continuation of the supplied CYBR WATER 2.3 standalone application, not a replacement stock ocean scene. The 2.3 continuous-triangle caustics repair is retained. The principal new changes are the camera controls, multi-system wave spectrum, persistent whitewater field, and whitewater/spray rendering.

## Run the application

Open the supplied `CYBR-WATER-2.4.html` directly, or build the self-contained copy from this source:

```sh
python tools/build.py
```

Open `public/standalone.html`. It embeds Three.js and all the supplied textures and HDR environment data. No asset server or npm install is needed for this file. Browser support for WebGL2, renderable floating-point textures, and `DecompressionStream` is required. Rendering speed depends on the graphics device.

For conventional hosting of the smaller modular page:

```sh
python -m http.server 8000 --directory public
```

Then visit `http://localhost:8000/`. All application assets are local to `public/`; there is no runtime CDN dependency.

## Camera controls

Scroll to dolly; pinch with two fingers on a touch screen. Drag to orbit. The controls panel also contains **Zoom out**, **Zoom in**, and **Home view**. The `-` and `+` keys zoom; `Home` returns to the cinematic view. There is no application maximum-distance clamp. Positive finite values are required and the close-distance minimum is 0.25 metres.

The camera's near/far clipping planes, sky shell, radial ocean coverage, and level-of-detail spacing scale with orbit distance/height. This avoids hitting the former 180 m stop or immediately revealing a finite water-patch edge. The ocean is still a periodically tiled planar model, not an Earth-curvature or planet-scale fluid simulation. Floating-point representability remains a numerical limit, not an intentional zoom limit.

The film's zoom take goes from 72 m to approximately 20 km and back. Separate camera tests include 500 m, 5 km, 100 km, and 1,000 km. The last figure is a camera/coverage test, not a claim to simulate distinct physics over a 1,000 km domain.

## Wave changes

The spectrum combines independently energy-normalized directional dominant swell, longer crossing swell, and a shorter, broader wind sea. Seeded coefficients are then normalized to the target spectral variance. The three existing nonoverlapping wavelength bands use 768 m, 96 m, and 12 m periods. Finite-depth dispersion and spectral displacement/derivative calculations are retained.

Desktop/high-quality builds use three 256-by-256 GPU FFT grids; the mobile/low-quality path uses 128-by-128 grids. Horizontal choppiness was tuned against the **combined** displacement Jacobian rather than only individual bands. See the sampled numerical audit for the tested space/time range; it is not a proof against all possible folding at every future time or setting.

## Whitewater changes

The previous bounded local whitewater coverage is replaced by a periodic field spanning the full 768 m large-wave period. It stores foam density, mass-weighted age, a short-lived recent-aeration proxy, and the preceding horizontal Jacobian. It uses filtering and mipmaps instead of exposing a square screen-space boundary.

Shading normals that disagree with a visible geometric crest are corrected toward the actual triangle normal rather than flipped downward. This removes the dark horizontal lighting slits observed in the rejected close-up draft.

Foam is generated using composed wave compression, crest height, and increasing compression. Surface-attached foam is tracked in the wave's material coordinates. Wind/local-flow drift is mapped through the horizontal deformation before history sampling. Density decays exponentially; new foam dilutes the age of older foam.

The material combines persistent coverage with wind-stretched, multi-scale porous microstructure. Fresh aeration and older foam are shaded differently, and fine structure is filtered as its screen footprint decreases. Spray emission is more selective and uses smaller droplets with velocity inherited from the water. These are whitewater **models for unresolved breaking**, not resolved liquid sheets, air entrainment, or a volumetric two-phase solver.

## Numerical checks

```sh
node tools/spectrum_audit.cjs
python tools/wave_audit.py
node tools/tests.cjs
```

The independent audit requires NumPy. It reconstructs wave fields at times 57, 61, 66, and 73 seconds and samples 80,000 deterministic points per time for each of five ocean presets. Its 1.6 million composed-surface samples are finite and have positive horizontal Jacobians in the recorded result. This is sampled validation, not a universal guarantee.

`tools/tests.cjs` performs 35 checks covering seeded resets, coefficient energy, band partitioning, finite reference fields, zero-height input, source-level camera/foam regression conditions, and the audit results. Cached audit results alone should not be treated as a fresh test after changing the spectrum: regenerate them first with the two commands above.

For actual browser/GPU field checks and wheel/pinch input checks:

```sh
python -m pip install numpy playwright
python -m playwright install chromium
xvfb-run -a python tools/browser_checks.py
```

The stored run was made in Linux Chromium with Mesa llvmpipe software rendering, including a portrait/touch-enabled browser context. This is not a physical Android-device certification.

## Record the new film

Install Chromium (or Playwright Chromium), ffmpeg, and Python Playwright. The reference capture command on the tested Linux environment is:

```sh
xvfb-run -a -s '-screen 0 1920x1080x24' python capture/render.py
python capture/assemble.py
```

`CHROMIUM_EXECUTABLE` may point to a different Chromium executable. The capture script loads the complete standalone document directly into a browser page and reads actual renderer frames. It uses a native 1920-by-1080 drawing buffer/viewport, 24 fps output, and fixed 60 Hz simulation ticks. It does not upscale, interpolate intermediate video frames, use image generation, or reuse earlier films. It records per-frame hashes, native sizes, sampled cameras, source hashes, error logs, and render time.

The five takes total 42 seconds: first light, crossing seas, overhead whitewater, gale-level tracking, and the 20 km zoom excursion. They are encoded from newly rendered frames. Assembly keeps the original high-bitrate take encodes in a master MP4 and also makes a smaller 20 Mb/s maximum viewing copy. Both remain native 1920 × 1080 at 24 fps with the same number of frames. The capture is offline and is **not** a measurement of real-time 24 fps performance.

## Source organization

`source/` contains readable, editable modules extracted from the supplied 2.3 document, with changes applied in place. Each module registers its exports on `__M`; `source/order.json` specifies the dependency order. `tools/build.py` combines them with the UI template and supplied vendor/assets into either a modular or standalone page. The registration wrappers avoid requiring a new bundler or network dependency.

See `LIMITATIONS.md`, `ATTRIBUTION.md`, `LICENSE`, and `THREE-LICENSE.txt`. The release does not replace the user's separate volumetric FLIP codebase.
