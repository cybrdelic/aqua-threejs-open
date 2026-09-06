# CYBR WATER 2.4 — measured release checks

## Delivered film

42 seconds; 1008 newly rendered frames; native 1920 × 1080; 24 fps playback. Five independently rendered takes. Full ffmpeg decoding passed. No scaling, frame interpolation, or earlier footage was used. A smaller viewing encode and the original high-bitrate master are both delivered. The application delivered alongside the film has the exact HTML hash recorded by the capture process.

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

Renderer: ANGLE (Mesa, llvmpipe (LLVM 19.1.7 256 bits), OpenGL 4.5).

HTML SHA256: `600bc4ca1321b20071bf97466217f2fe3ac4b2e9f7848d4d83f0b5612d180268`

Video SHA256: `d67cb54d5ce113aa938bf00fdf6bdfcdce6d19d40d8a391097975a8617c7f4a6`

The film was rendered offline. Playback frame rate does not demonstrate real-time rendering speed. The model remains a spectral ocean with modeled secondary whitewater and a local depth-averaged interaction field; see `LIMITATIONS.md`.
