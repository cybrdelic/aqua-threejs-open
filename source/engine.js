__M["src/engine.js"]=(()=>{

const { RayScene }=__M["src/ray-scene.js"];
const { THREE, Pass, target, uniform:U }=__M["src/gpu.js"];
const { GPUOcean }=__M["src/gpu-ocean.js"];
const { InteractionField, WhitewaterField }=__M["src/sim-fields.js"];
const { World }=__M["src/world.js"];
const { WorldShadows }=__M["src/shadows.js"];
const { Caustics }=__M["src/caustics.js"];
const { PostProcessor }=__M["src/post.js"];
const { Dynamics }=__M["src/dynamics.js"];
const { RainRipples }=__M["src/rain-ripples.js"];
const { SecondaryParticles, Rain }=__M["src/particles.js"];
const { sharedEnvironment, loadEnvironment }=__M["src/environment.js"];
const { waterVertex, waterFragment }=__M["src/water-shaders.js"];
const { ReplayJournal }=__M["src/replay.js"];
const { PRESETS, FIXED_DT, SEED }=__M["src/config.js"];
function radialGeometry(radial = 250, angular = 480, radius = 14000) {
  const vertices = new Float32Array((radial + 1) * (angular + 1) * 3),
    indices = new Uint32Array(radial * angular * 6);
  const base = 11,
    log = Math.log1p(radius / base);
  let k = 0;
  for (let j = 0; j <= radial; j++) {
    const r = base * Math.expm1((log * j) / radial);
    for (let i = 0; i <= angular; i++) {
      const a = (i / angular) * 2 * Math.PI,
        idx = (j * (angular + 1) + i) * 3;
      vertices[idx] = r * Math.cos(a);
      vertices[idx + 2] = r * Math.sin(a);
    }
  }
  for (let j = 0; j < radial; j++)
    for (let i = 0; i < angular; i++) {
      const a = j * (angular + 1) + i,
        b = a + angular + 1;
      indices[k++] = a;
      indices[k++] = a + 1;
      indices[k++] = b;
      indices[k++] = b;
      indices[k++] = a + 1;
      indices[k++] = b + 1;
    }
  const g = new THREE.BufferGeometry();
  g.setAttribute("position", new THREE.BufferAttribute(vertices, 3));
  g.setIndex(new THREE.BufferAttribute(indices, 1));
  return g;
}
class WaterEngine {
  constructor(canvas, width, height, { grid = 128, high = true } = {}) {
    this.canvas = canvas;
    this.width = width;
    this.height = height;
    this.grid = grid;
    this.high = high;
    this.renderer = new THREE.WebGLRenderer({
      canvas,
      alpha: false,
      antialias: false,
      preserveDrawingBuffer: true,
      powerPreference: "high-performance",
    });
    this.renderer.autoClear = false;
    this.renderer.setPixelRatio(1);
    this.renderer.setSize(width, height, false);
    this.renderer.outputColorSpace = THREE.LinearSRGBColorSpace;
    this.renderer.toneMapping = THREE.NoToneMapping;
    if (!this.renderer.extensions.has("EXT_color_buffer_float"))
      throw new Error("Floating-point render targets are required");
    if(this.renderer.extensions.has("EXT_float_blend"))this.renderer.extensions.get("EXT_float_blend");
    const gl=this.renderer.getContext(),fp=gl.getShaderPrecisionFormat(gl.FRAGMENT_SHADER,gl.HIGH_FLOAT);
    this.portability={highFloatMantissaBits:fp.precision,floatLinear:this.renderer.extensions.has("OES_texture_float_linear"),floatBlend:this.renderer.extensions.has("EXT_float_blend"),depthPipeline:"one native raster depth attachment; no sampled-depth copy",samples:0};
    this.camera = new THREE.PerspectiveCamera(52, width / height, 0.08, 24000);
    this.reflectionCamera = this.camera.clone();
    this.vp = new THREE.Matrix4();
    this.cameraTarget = new THREE.Vector3();
    this.time = 57;
    this.tick = 0;
    this.filmTime = 0;
    this.accumulator = 0;
    this.frameCount = 0;
    this.debug = 0;
    this.sceneKey = "blue";
    this.underwater = 0;
    this.flags = {
      foam: true,
      spray: true,
      rain: true,
      caustics: true,
      reflections: true,
      taa: true,
    };
    this.lastGPUReports = null;
    this.journal = new ReplayJournal(SEED);
  }
  async initialize() {
    console.log("INIT assets");
    this.assets = await loadEnvironment();
    console.log("INIT assets ready");
    this.shared = sharedEnvironment(this.assets);
    Object.assign(this.shared, {
      uClip: U(0),
      uCausticEnable: U(0),
      uCaustics: U(null),
      uCausticSize: U(96),
      uUnderwater: U(0),
      uShadowDepth: U(null),
      uShadowMatrix: U(new THREE.Matrix4()),
    });
    console.log("INIT GPU");
    this.ocean = new GPUOcean(this.renderer, this.grid);
    Object.assign(this.shared, this.ocean.uniforms);
    this.shared.uEyeSurface = U(new THREE.Vector4(0, 1, 0, 0));
    this.shared.uPixelFootprint = U(1 / this.height);
    this.shared.uOpaqueDepth = U(null);
    this.shared.uOverlayResolution = U(
      new THREE.Vector2(this.width, this.height),
    );
    this.shared.uOverlayInvVP = U(new THREE.Matrix4());
    this.patch = new InteractionField(this.renderer);
    this.whitewater = new WhitewaterField(
      this.renderer,
      this.ocean,
      this.patch,
      this.high ? 512 : 256,
      768,
    );
    console.log("INIT world");
    this.world = new World(this.shared);
    this.rayScene = new RayScene(this.world);
    console.log("BVH", JSON.stringify(this.rayScene.stats));
    console.log("INIT world ready");
    this.shadows = new WorldShadows(this.renderer, this.world, this.shared);
    this.caustics = new Caustics(
      this.renderer,
      this.ocean,
      this.shared,
      this.high ? 256 : 128,
    );
    this.shared.uCaustics.value = this.caustics.target.texture;
    this.particles = new SecondaryParticles(this.shared);
    this.rain = new Rain(this.shared);
    this.rainRipples = new RainRipples(this.renderer);
    this.dynamics = new Dynamics(this.world);
    console.log("INIT targets");

    this.mainRT = target(this.width, this.height, {
      count: 2,
      type: THREE.HalfFloatType,
      linear: true,
      depth: true,
    });
    // A multisampled floating-point MRT depth resolve is driver-sensitive.
    // Subpixel temporal reconstruction is the portable default; no MSAA depth copy.
    this.mainRT.samples = 0;
    this.waterUniforms = {
      ...this.shared,
      ...this.rayScene.uniforms,
      uRainRing: U(this.rainRipples.target.texture),
      uRainRingSize: U(this.rainRipples.size),
      uRainEnable: U(0),
      ...this.ocean.uniforms,
      uMicro: U(this.assets.foam),
      uViewProjection: U(this.vp),
      uInverseViewProjection: U(new THREE.Matrix4()),
      uViewMatrix: U(new THREE.Matrix4()),
      uReflectionMatrix: U(new THREE.Matrix4()),
      uHullInverse: U(new THREE.Matrix4()),
      uResolution: U(new THREE.Vector2(this.width, this.height)),
      uInteraction: U(this.patch.texture),
      uWhitewater: U(this.whitewater.texture),
      uPatchSize: U(this.patch.size),
      uFoamSize: U(this.whitewater.size),
      uTessellation: U(
        new THREE.Vector2(this.high ? 280 : 200, this.high ? 512 : 320),
      ),
      uRoughness: U(0.05),
      uWind: U(5),
      uHs:U(4),uFoamThreshold:U(.65),uWindDirection:U(new THREE.Vector2(1,0)),
      uOceanExtent:U(14000),uOceanBase:U(11),
      uTerrain: U(1),
      uObjects: U(1),
      uBoat: U(0),
      uDebug: U(0),
      uFoamEnable: U(1),
      uSprayEnable: U(1),
      uReflections: U(1),
    };
    this.waterMaterial = new THREE.RawShaderMaterial({
      glslVersion: THREE.GLSL3,
      vertexShader: waterVertex,
      fragmentShader: waterFragment,
      uniforms: this.waterUniforms,
      side: THREE.DoubleSide,
      depthTest: true,
      depthWrite: true,
    });
    this.waterMesh = new THREE.Mesh(
      radialGeometry(this.high ? 280 : 200, this.high ? 512 : 320),
      this.waterMaterial,
    );
    this.waterMesh.frustumCulled = false;
    this.waterScene = new THREE.Scene();
    this.waterScene.add(this.waterMesh);
    console.log("INIT post");
    this.post = new PostProcessor(
      this.renderer,
      this.shared,
      this.width,
      this.height,
    );
    console.log("INIT preset");
    this.setPreset(this.sceneKey);
    console.log("INIT preset ready");
    this.setCamera({ eye: [17, 7, 23], target: [-9, -0.3, -14], fov: 50 });
    console.log("INIT render");
    this.render();
    console.log("INIT done");
    return this;
  }
  setPreset(key, { warm = true } = {}) {
    if (!PRESETS[key]) throw new Error("Unknown preset " + key);
    this.sceneKey = key;
    this.journal.reset(key);
    this.flags = {
      foam: true,
      spray: true,
      rain: true,
      caustics: true,
      reflections: true,
      taa: true,
    };
    this.debug = 0;
    this.preset = { ...PRESETS[key] };
    const p = this.preset;
    this.time = 57;
    this.tick = 0;
    this.filmTime = 0;
    this.accumulator = 0;
    this.ocean.reset(p, SEED);
    this.patch.reset();
    this.whitewater.reset();
    this.particles.reset();
    this.rain.reset();
    this.rainRipples.reset();
    this.world.configure(p);
    this.rayScene.syncStaticWorld(this.world);
    this.patch.configure(this.world, p);
    this.dynamics.reset(p);
    this.shared.uSky.value = this.assets.skies[p.sky];
    this.shared.uSkySH.value = this.assets.skies[p.sky].userData.irradiance;
    this.shared.uSkyYaw.value = p.skyYaw || 0;
    this.shared.uSun.value.fromArray(p.sun).normalize().applyAxisAngle(new THREE.Vector3(0,1,0),this.shared.uSkyYaw.value);
    this.shared.uSunColor.value.fromArray(p.sunColor);
    this.shared.uExposure.value = p.exposure;
    this.shared.uAbsorption.value.fromArray(p.absorption);
    this.shared.uScattering.value.fromArray(p.scattering);
    this.shared.uWaterLight.value.fromArray(p.waterLight);
    this.shared.uBed.value.fromArray(p.bed);
    if (warm) {
      for (let i = 0; i < 90; i++) {
        this.ocean.step(51 + (i + 1) / 15);
        this.whitewater.step(1/15, p);
      }
    }
    this.ocean.step(this.time);
    this.shadows.render();
    this.caustics.render();
    this.post?.reset();
    this.historyReset = true;
    this.frameCount = 0;
  }
  setCamera({ eye, target, fov = 52, up = [0, 1, 0] }) {
    this.camera.position.fromArray(eye);
    this.camera.up.fromArray(up);
    this.cameraTarget.fromArray(target);
    const distance=this.camera.position.distanceTo(this.cameraTarget);
    this.camera.near=Math.max(.045,distance*.00002,Math.abs(eye[1])*.0008);
    const extent=Math.max(14000,distance*16,Math.abs(eye[1])*36);
    this.camera.far=Math.max(24000,extent*2.5+Math.abs(eye[1])*4);
    if(this.waterUniforms){
      this.waterUniforms.uOceanExtent.value=extent;
      this.waterUniforms.uOceanBase.value=Math.max(11,Math.abs(eye[1])*.12);
    }
    if(this.world){this.world.sky.position.copy(this.camera.position);this.world.sky.scale.setScalar(this.camera.far*.44/19000);}
    this.camera.fov = fov;
    this.camera.aspect = this.width / this.height;
    this.camera.updateProjectionMatrix();
    this.camera.lookAt(this.cameraTarget);
    this.camera.updateMatrixWorld();
    this.currentCamera = { eye: eye.slice(), target: target.slice(), fov };
  }
  command(type, payload) {
    return this.journal.enqueue(this.tick + 1, type, payload);
  }
  applyEvent(event) {
    const p = event.payload;
    if (event.type === "impulse")
      this.patch.impulse(p.x, p.z, p.height, p.radius, p.foam);
    if (event.type === "flag") this.flags[p.name] = p.value;
    if (event.type === "extinction") {
      this.shared.uAbsorption.value
        .fromArray(this.preset.absorption)
        .multiplyScalar(p.scale);
      this.shared.uScattering.value
        .fromArray(this.preset.scattering)
        .multiplyScalar(p.scale);
    }
  }
  loadReplay(doc) {
    if (doc.model !== undefined && doc.model !== "cybr-water-2.4")
      throw new TypeError("Replay uses a different physical model revision");
    if (doc.grid !== undefined && doc.grid !== this.grid)
      throw new TypeError(
        "Replay spectral resolution differs from this session",
      );
    if (!PRESETS[doc.scene]) throw new TypeError("Unknown replay scene");
    this.setPreset(doc.scene);
    this.journal.load(doc);
  }
  pickWater(ndcX, ndcY) {
    const origin = this.camera.position.clone(),
      point = new THREE.Vector3(ndcX, ndcY, 0.5).unproject(this.camera),
      ray = point.sub(origin).normalize();
    if (ray.y >= -0.015) return null;
    let t = -origin.y / ray.y;
    for (let i = 0; i < 5; i++) {
      const p = origin.clone().addScaledVector(ray, t),
        sample = this.ocean.query(
          [[p.x, p.z]],
          this.patch.texture,
          this.patch.size,
        )[0];
      t = (sample.height - origin.y) / ray.y;
    }
    const p = origin.addScaledVector(ray, t);
    return t > 0 &&
      Math.abs(p.x) < this.patch.size * 0.45 &&
      Math.abs(p.z) < this.patch.size * 0.45
      ? p
      : null;
  }
  fixedStep() {
    const dt = FIXED_DT;
    this.tick++;
    this.journal.consume(this.tick, (e) => this.applyEvent(e));
    this.time = 57 + this.tick * dt;
    this.ocean.step(this.time);
    this.dynamics.sampleAndStep(
      dt,
      this.tick * dt,
      this.ocean,
      this.patch,
      this.particles,
      this.preset,
    );
    if (this.flags.rain)
      this.rain.step(
        dt,
        this.patch,
        this.preset,
        this.rainRipples,
        this.tick * dt,
        this.ocean,
      );
    if(this.preset.terrain||this.preset.boat||this.preset.buoys||this.preset.rain||(this.journal.events?.length||0)) this.patch.step(dt);
    this.whitewater.step(dt, this.preset);
    this.particles.step(dt, this.time, this.preset, this.ocean, this.patch);
  }
  advance(delta = 1 / 24) {
    if (!Number.isFinite(delta) || delta < 0 || delta > 4)
      throw new RangeError(
        "Time advance must be finite and between zero and four seconds",
      );
    this.accumulator += delta;
    let steps = 0;
    while (this.accumulator >= FIXED_DT - 1e-10) {
      this.fixedStep();
      this.accumulator -= FIXED_DT;
      steps++;
      if (steps > 240) throw new Error("Step budget exceeded");
    }
    this.filmTime += delta;
  }
  render() {
    const r = this.renderer,
      p = this.preset,
      u = this.waterUniforms,
      s = this.shared,
      c = this.camera;
    s.uTime.value = this.time;
    s.uPixelFootprint.value =
      (2 * Math.tan((c.fov * Math.PI) / 360)) / this.height;
    s.uCausticEnable.value = p.caustics && this.flags.caustics ? 1 : 0;
    this.particles.material.uniforms.uPointScale.value = this.height * 1.2;
    if (p.boat || p.buoys) this.shadows.render();
    if (p.caustics && this.flags.caustics) this.caustics.render();
    if (p.rain && this.flags.rain)
      this.rainRipples.render(this.tick * FIXED_DT);
    u.uRainEnable.value = p.rain && this.flags.rain ? 1 : 0;
    const eyeProbe = this.ocean.query(
      [[c.position.x, c.position.z]],
      this.patch.texture,
      this.patch.size,
    )[0];
    this.cameraSurfaceHeight = eyeProbe.height;
    this.shared.uEyeSurface.value.set(...eyeProbe.normal, eyeProbe.height);
    const previousMedium = this.underwater;
    this.underwater = c.position.y < eyeProbe.height ? 1 : 0;
    if (previousMedium !== this.underwater) this.post.reset();
    s.uUnderwater.value = this.underwater;
    // Triangle visibility replaces planar reflection and screen-depth guesses.
    s.uClip.value = 0;
    s.uEye.value.copy(c.position);
    this.rayScene.update(p);
    // Subpixel camera samples turn the temporal resolver into actual TAA.
    // They affect visibility only: simulation positions and time are unchanged.
    this.baseProjection = c.projectionMatrix.clone();
    if (this.flags.taa && !this.debug) {
      const radical = (i, b) => {
        let f = 1,
          r = 0;
        while (i > 0) {
          f /= b;
          r += f * (i % b);
          i = Math.floor(i / b);
        }
        return r;
      };
      const index = (this.frameCount % 8) + 1;
      c.projectionMatrix.elements[8] +=
        ((radical(index, 2) - 0.5) * 2) / this.width;
      c.projectionMatrix.elements[9] +=
        ((radical(index, 3) - 0.5) * 2) / this.height;
      c.projectionMatrixInverse.copy(c.projectionMatrix).invert();
    }
    c.updateMatrixWorld();
    this.vp.multiplyMatrices(c.projectionMatrix, c.matrixWorldInverse);
    u.uInverseViewProjection.value.copy(this.vp).invert();
    u.uViewMatrix.value.copy(c.matrixWorldInverse);
    u.uInteraction.value = this.patch.texture;
    u.uWhitewater.value = this.whitewater.texture;
    u.uRoughness.value = p.roughness;
    u.uWind.value = p.wind;
    u.uHs.value=p.hs;u.uFoamThreshold.value=p.foamThreshold;u.uWindDirection.value.set(Math.cos(p.direction),Math.sin(p.direction));
    u.uTerrain.value = p.terrain ? 1 : 0;
    u.uObjects.value = p.terrain || p.boat || p.buoys ? 1 : 0;
    u.uBoat.value = p.boat ? 1 : 0;
    u.uDebug.value = this.debug;
    u.uFoamEnable.value = this.flags.foam ? 1 : 0;
    u.uReflections.value = this.flags.reflections ? 1 : 0;
    if (p.boat) u.uHullInverse.value.copy(this.world.boat.matrixWorld).invert();
    // One depth attachment. A rock and water fragment are compared by the
    // rasterizer, not a low-precision sampled copy of near-one nonlinear depth.
    r.setRenderTarget(this.mainRT);
    r.setClearColor(0, 0);
    r.clear();
    r.render(this.world.scene, c);
    r.render(this.waterScene, c);
    this.post.uniforms.uTAA.value = this.flags.taa && !this.debug ? 1 : 0;
    s.uOpaqueDepth.value = this.mainRT.depthTexture;
    s.uOverlayResolution.value.set(this.width, this.height);
    s.uOverlayInvVP.value.copy(this.vp).invert();
    // Transparent particles use their own optical path, after the opaque volume
    // resolve. Their depth is never substituted with the distant sea floor.
    this.post.render(this.mainRT, this.vp, this.underwater, this.time, () => {
      if (this.flags.spray && !this.debug) r.render(this.particles.scene, c);
      if (p.rain && this.flags.rain && !this.debug)
        r.render(this.rain.scene, c);
    });
    c.projectionMatrix.copy(this.baseProjection);
    c.projectionMatrixInverse.copy(c.projectionMatrix).invert();
    this.frameCount++;
    this.renderer.setRenderTarget(null);
  }
  resize(w, h) {
    this.width = w;
    this.height = h;
    this.renderer.setSize(w, h, false);
    for (const rt of [this.mainRT]) rt.setSize(w, h);
    this.post.resize(w, h);
    this.waterUniforms.uResolution.value.set(w, h);
    if (this.currentCamera) this.setCamera(this.currentCamera);
  }
  diagnosticSamples() {
    const q = [];
    for (let z = 0; z < 8; z++)
      for (let x = 0; x < 12; x++)
        q.push([(x / 11 - 0.5) * 100, (z / 7 - 0.5) * 100]);
    const samples = this.ocean.query(q, this.patch.texture, this.patch.size);
    let lo = Infinity,
      hi = -Infinity,
      sum = 0,
      finite = true;
    for (const s of samples) {
      lo = Math.min(lo, s.jacobian);
      hi = Math.max(hi, s.height);
      sum += s.height;
      finite =
        finite && Number.isFinite(s.height) && Number.isFinite(s.jacobian);
    }
    return {
      minimumSampledCombinedJacobian: lo,
      maxSampledHeight: hi,
      meanProbeHeight: sum / samples.length,
      finite,
      samples: samples.length,
    };
  }
  diagnostics(deep = false) {
    const gl = this.renderer.getContext(),
      ex = gl.getExtension("WEBGL_debug_renderer_info");
    const d = {
      build: "CYBR WATER 2.4 / unified-depth renderer",
      rayScene: this.rayScene.stats,
      portability: this.portability,
      backend: "Three.js r" + THREE.REVISION,
      renderer: ex
        ? gl.getParameter(ex.UNMASKED_RENDERER_WEBGL)
        : "undisclosed",
      scene: this.sceneKey,
      time: this.time,
      tick: this.tick,
      seed: SEED,
      fixedStep: FIXED_DT,
      spectrum: "GPU atlas IFFT, three disjoint JONSWAP bands",
      grid: this.grid,
      resolution: [this.width, this.height],
      waterTriangles: this.waterMesh.geometry.index.count / 3,
      programs: this.renderer.info.programs.length,
      particles: this.particles.counts,
      rainImpacts: this.rain.impacts,
      resolvedRainRings: this.rainRipples.events.length,
      underwater: !!this.underwater,
      bodyStates: this.dynamics.lastReports || [],
      flags: { ...this.flags },
      camera: this.currentCamera,
    };
    if (deep) {
      d.surface = this.diagnosticSamples();
      d.interaction = this.patch.diagnostics();
    }
    return d;
  }
}



return {WaterEngine};
})();
