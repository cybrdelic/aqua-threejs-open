# Asset provenance

## Runtime dependency
Three.js r180, Three.js authors, MIT. See THREE-LICENSE.txt.
https://github.com/mrdoob/three.js/tree/r180

## Photographic environment lighting — CC0
Kloofendal 48d Partly Cloudy (Pure Sky), Greg Zaal and Jarod Guest, Poly Haven.
https://polyhaven.com/a/kloofendal_48d_partly_cloudy_puresky
https://dl.polyhaven.org/file/ph-assets/HDRIs/hdr/2k/kloofendal_48d_partly_cloudy_puresky_2k.hdr

Belfast Sunset (Pure Sky), Poly Haven.
https://polyhaven.com/a/belfast_sunset_puresky
https://dl.polyhaven.org/file/ph-assets/HDRIs/hdr/2k/belfast_sunset_puresky_2k.hdr

The preparation script rotates the lighting, removes the small source sun disc,
scales radiance and supplies a continuous lower-hemisphere closure. The analytic
sun is separate. The storm sky is inherited original procedural lighting.

## Surface textures — CC0
Rock Face: Dario Barresi (processing), Greg Zaal (photography), Poly Haven.
https://polyhaven.com/a/rock_face
Damp Sand: eye-candy.xyz, Poly Haven.
https://polyhaven.com/a/damp_sand

The source downloads are the diffuse and OpenGL-normal JPG maps at 2k. The
runtime version is resized to 1024², mipmapped and sampled in world coordinates.
No scanned or downloaded water mesh, water normal animation or water footage is
used. The inherited foam/microstructure texture images are included as baked assets;
wave geometry, wave dynamics, and the new whitewater transport/shading are code-driven. No font files are redistributed.
