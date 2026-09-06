__M["src/repair-validation.js"]=(()=>{

const { THREE, Pass, target, dataTexture, uniform:U }=__M["src/gpu.js"];
const { raySceneGLSL }=__M["src/ray-scene.js"];
const { environmentGLSL }=__M["src/environment.js"];
const { InteractionField }=__M["src/sim-fields.js"];
const { mulberry32 }=__M["src/math.js"];
const { directSolarTransferJS }=__M["src/light-transport.js"];
const { waterFragment }=__M["src/water-shaders.js"];

/** Independent reference and adversarial checks for the repaired code paths.
 * Deliberately reports measured error and scope, rather than 'physics proved'. */
function validateRepairs(engine) {
  const r = engine.renderer,
    old = engine.sceneKey,
    report = { build: "2.1-repair", checks: {} };
  const ensure = (ok, msg) => {
    if (!ok) throw new Error("Repair regression: " + msg);
  };
  const read = (rt) => {
    const a = new Float32Array(rt.width * rt.height * 4);
    r.readRenderTargetPixels(rt, 0, 0, rt.width, rt.height, a);
    return a;
  };
  engine.setPreset("harbor");
  const grounding = { ...engine.world.groundingReport };
  ensure(
    grounding.rocks === 93 && grounding.maximumRemainingGap <= -0.03999,
    "Static scene contains unsupported rocks",
  );
  report.checks.staticRockGrounding = grounding;
  ensure(
    engine.rayScene.rockPlacementKey === engine.world.rockPlacementKey,
    "Static ray scene is stale after grounding",
  );

  engine.rayScene.update({ terrain: true, boat: true, buoys: true });
  const meshes = engine.rayScene.instances.flatMap((i) => i.meshes),
    rng = mulberry32(672923),
    N = 256,
    positions = new Float32Array(N * 8),
    rays = [];
  const raycaster = new THREE.Raycaster(),
    originalSides = meshes.map((m) => m.material.side);
  meshes.forEach((m) => {
    m.material.side = THREE.DoubleSide;
    m.updateMatrixWorld(true);
  });
  for (let i = 0; i < N; i++) {
    const mesh = meshes[i % meshes.length];
    mesh.geometry.computeBoundingBox();
    const center = mesh.geometry.boundingBox
      .getCenter(new THREE.Vector3())
      .applyMatrix4(mesh.matrixWorld);
    const o = center
      .clone()
      .add(
        new THREE.Vector3(
          (rng() - 0.5) * 60,
          (rng() - 0.3) * 32,
          (rng() - 0.5) * 60,
        ),
      );
    const d = center
      .clone()
      .add(
        new THREE.Vector3(
          (rng() - 0.5) * 3,
          (rng() - 0.5) * 3,
          (rng() - 0.5) * 3,
        ),
      )
      .sub(o)
      .normalize();
    positions.set([...o.toArray(), 0], i * 4);
    positions.set([...d.toArray(), 0], N * 4 + i * 4);
    raycaster.set(o, d);
    const reference = raycaster
      .intersectObjects(meshes, false)
      .find((h) => h.distance > 0.001);
    rays.push({
      o: o.toArray(),
      d: d.toArray(),
      distance: reference?.distance ?? 350,
      hit: !!reference,
    });
  }
  const rayInput = dataTexture(positions, N, 2),
    out = target(N, 1);
  const uniforms = {
    ...engine.shared,
    ...engine.rayScene.uniforms,
    uTestRays: U(rayInput),
  };
  const pass = new Pass(
    `precision highp float;precision highp int;in vec2 vUv;out vec4 fragColor;${environmentGLSL}${raySceneGLSL}
 uniform highp sampler2D uTestRays;
 void main(){int id=int(gl_FragCoord.x);vec3 o=texelFetch(uTestRays,ivec2(id,0),0).xyz,d=texelFetch(uTestRays,ivec2(id,1),0).xyz;float len=350.,kind;vec3 n,a;bool hit=traceTriangles(o,d,len,n,a,kind);fragColor=vec4(len,hit?1.:0.,0.,1.);}`,
    uniforms,
  );
  pass.run(r, out);
  const gpu = read(out);
  let maxError = 0,
    mismatches = 0,
    hits = 0;
  for (let i = 0; i < N; i++) {
    if (gpu[i * 4 + 1] > 0.5 !== rays[i].hit) mismatches++;
    if (rays[i].hit) {
      hits++;
      maxError = Math.max(maxError, Math.abs(gpu[i * 4] - rays[i].distance));
    }
  }
  report.checks.triangleVisibility = {
    rays: N,
    hits,
    missClassificationErrors: mismatches,
    maximumDistanceErrorMetres: maxError,
    reference:
      "Independent THREE.Raycaster over the same nondegenerate mesh triangles; static and rigid instances",
  };
  ensure(
    mismatches === 0 && maxError < 0.02,
    "GPU triangle traversal differs from independent reference " +
      JSON.stringify(report.checks.triangleVisibility),
  );
  const cam = engine.camera.position.clone();
  engine.shared.uEye.value.set(91, 42, -65);
  pass.run(r, out);
  const moved = read(out);
  ensure(
    gpu.every((v, i) => v === moved[i]),
    "Off-screen visibility changed with the camera",
  );
  report.checks.cameraIndependentSecondaryVisibility = {
    bitwiseEqual: true,
    rays: N,
  };
  engine.shared.uEye.value.copy(cam);
  meshes.forEach((m, i) => (m.material.side = originalSides[i]));
  pass.dispose();
  out.dispose();
  rayInput.dispose();

  // Rasterized bathymetry must refer to the same world cells, not a flipped map.
  const bedMeshes = [engine.world.ground, ...engine.world.rocks];
  bedMeshes.forEach((m) => {
    m.updateMatrixWorld(true);
    m.geometry.computeBoundingSphere();
  });
  let bathError = 0,
    bathSamples = 0;
  for (let j = 0; j < 12; j++)
    for (let i = 0; i < 12; i++) {
      const x = ((7 + i * 20 + 0.5) / 256 - 0.5) * 128,
        z = ((5 + j * 21 + 0.5) / 256 - 0.5) * 128;
      raycaster.set(new THREE.Vector3(x, 200, z), new THREE.Vector3(0, -1, 0));
      const hit = raycaster.intersectObjects(bedMeshes, false)[0];
      if (hit) {
        bathSamples++;
        bathError = Math.max(
          bathError,
          Math.abs(hit.point.y - engine.patch.topAt(x, z)),
        );
      }
    }
  report.checks.bathymetryRegistration = {
    samples: bathSamples,
    maximumHeightErrorMetres: bathError,
  };
  ensure(
    bathError < 0.002,
    "Static obstacle/bathymetry map has wrong registration",
  );

  // Actual multi-row query path compared to the original single-row GPU path.
  const points = Array.from({ length: 513 }, () => [
    (rng() - 0.5) * 94,
    (rng() - 0.5) * 94,
  ]);
  const batch = engine.ocean.query(
      points,
      engine.patch.texture,
      engine.patch.size,
    ),
    reference = [];
  for (let i = 0; i < points.length; i += 128)
    reference.push(
      ...engine.ocean.query(
        points.slice(i, i + 128),
        engine.patch.texture,
        engine.patch.size,
      ),
    );
  let queryError = 0;
  for (let i = 0; i < batch.length; i++) {
    const a = [
        batch[i].height,
        batch[i].jacobian,
        ...batch[i].normal,
        ...batch[i].velocity,
      ],
      b = [
        reference[i].height,
        reference[i].jacobian,
        ...reference[i].normal,
        ...reference[i].velocity,
      ];
    for (let j = 0; j < a.length; j++)
      queryError = Math.max(queryError, Math.abs(a[j] - b[j]));
  }
  report.checks.batchedSurfaceContacts = {
    points: points.length,
    maxError: queryError,
  };
  ensure(queryError < 1e-6, "Batched contact query indexing");

  // GPU depth-averaged field, an impermeable dry wall, and no-flow face fluxes.
  const field = new InteractionField(r, 64, 32, 2),
    n = field.n;
  function setDepth(wall = false) {
    for (let j = 0; j < n; j++)
      for (let i = 0; i < n; i++) {
        const k = (j * n + i) * 4,
          H = wall && i >= 31 && i <= 33 ? 0 : 2;
        const right = wall && i + 1 >= 31 && i + 1 <= 33 ? 0 : 2;
        field.bedData.set(
          [
            H,
            H && right && i < n - 1 ? 2 : 0,
            H && j < n - 1 ? 2 : 0,
            H ? -2 : 3,
          ],
          k,
        );
      }
    field.bedTexture.needsUpdate = true;
    field.maxDepth = 2;
  }
  setDepth();
  field.active = true;
  for (let i = 0; i < 20; i++) field.step(1 / 60);
  let data = read(field.a);
  ensure(
    data.every((v) => v === 0),
    "Lake at rest generated waves",
  );
  report.checks.lakeAtRest = { ticks: 20, maximumAbsoluteState: 0 };
  field.reset();
  setDepth();
  field.impulse(-0.17, 0.21, 0.4, 0.32, 0, [130, -55]);
  field.step(1 / 600);
  const source = read(field.sources);
  let volume = 0,
    px = 0,
    pz = 0;
  for (let i = 0; i < source.length; i += 4) {
    volume += source[i] * field.dx ** 2;
    px += source[i + 1] * field.bedData[i + 1] * 1025 * field.dx ** 2;
    pz += source[i + 2] * field.bedData[i + 2] * 1025 * field.dx ** 2;
  }
  report.checks.discreteSourceGPU = {
    volumeMetresCubed: volume,
    expectedHorizontalMomentum: [130, -55],
    measuredHorizontalMomentum: [px, pz],
  };
  ensure(
    Math.abs(volume) < 2e-7 &&
      Math.abs(px - 130) < 0.003 &&
      Math.abs(pz + 55) < 0.003,
    "Source stencil mass/momentum normalization",
  );
  field.reset();
  setDepth(true);
  field.impulse(-4.4, 0, 0.25, 0.8, 0, [60, 0]);
  for (let i = 0; i < 180; i++) field.step(1 / 60);
  data = read(field.a);
  let dryMax = 0,
    oppositeMax = 0,
    leftEnergy = 0;
  for (let j = 0; j < n; j++)
    for (let i = 0; i < n; i++) {
      const k = (j * n + i) * 4;
      ensure(
        [0, 1, 2, 3].every((a) => Number.isFinite(data[k + a])),
        "Nonfinite wall-test state",
      );
      if (i >= 31 && i <= 33)
        for (let a = 0; a < 4; a++)
          dryMax = Math.max(dryMax, Math.abs(data[k + a]));
      if (i >= 34) oppositeMax = Math.max(oppositeMax, Math.abs(data[k]));
      if (i < 31) leftEnergy += data[k] ** 2;
    }
  report.checks.impermeableWall = {
    ticks: 180,
    maxDryCellState: dryMax,
    maxHeightBeyondWall: oppositeMax,
    nonzeroIncidentEnergy: leftEnergy,
  };
  ensure(
    dryMax === 0 && oppositeMax === 0 && leftEnergy > 1e-6,
    "Wall leaks or suppresses the whole field",
  );
  field.a.dispose();
  field.b.dispose();
  field.sources.dispose();
  field.bedTexture.dispose();
  field.pass.dispose();
  field.material.dispose();
  field.geometry.dispose();

  // Check the actual GLSL optical source term, including the zero-scattering limit.
  const optics = new Pass(
    `precision highp float;in vec2 vUv;out vec4 fragColor;${environmentGLSL}
 void main(){float d=gl_FragCoord.x-.5;fragColor=vec4(waterInscatter(vec3(0.,0.,-1.),d),transmittance(d).x);}`,
    { ...engine.shared },
  );
  const opticalRT = target(32, 1),
    absorption = engine.shared.uAbsorption.value.clone(),
    scatter = engine.shared.uScattering.value.clone();
  engine.shared.uAbsorption.value.set(0.2, 0.1, 0.04);
  engine.shared.uScattering.value.set(0, 0, 0);
  optics.run(r, opticalRT);
  const pure = read(opticalRT);
  let emission = 0,
    attenuationError = 0;
  for (let i = 0; i < 32; i++) {
    for (let c = 0; c < 3; c++)
      emission = Math.max(emission, Math.abs(pure[i * 4 + c]));
    attenuationError = Math.max(
      attenuationError,
      Math.abs(pure[i * 4 + 3] - Math.exp(-0.2 * i)),
    );
  }
  report.checks.pureAbsorption = {
    maximumSpuriousEmission: emission,
    maximumTransmissionError: attenuationError,
  };
  ensure(
    emission === 0 && attenuationError < 1e-6,
    "Absorption emits light or violates path-length law",
  );
  engine.shared.uAbsorption.value.copy(absorption);
  engine.shared.uScattering.value.copy(scatter);
  optics.dispose();
  opticalRT.dispose();

  // GPU/independent analytical reference for refracted beam energy and RGB loss.
  const beamRT = target(32, 1),
    beamPass = new Pass(
      `precision highp float;in vec2 vUv;out vec4 fragColor;${environmentGLSL}
 void main(){float k=gl_FragCoord.x-.5,mu=.05+.90*k/31.;vec3 sun=vec3(sqrt(1.-mu*mu),mu,0.),L;vec3 tr=directSolarTransfer(sun,vec3(.32,.08,.025),k*.3,true,.7,L);fragColor=vec4(tr,L.y);}`,
      engine.shared,
    );
  beamPass.run(r, beamRT);
  const beams = read(beamRT);
  let beamError = 0;
  for (let i = 0; i < 32; i++) {
    const mu = 0.05 + (0.9 * i) / 31,
      ref = directSolarTransferJS(
        [Math.sqrt(1 - mu * mu), mu, 0],
        [0.32, 0.08, 0.025],
        i * 0.3,
        true,
        0.7,
      ),
      expected = [...ref.transfer, ref.direction[1]];
    for (let c = 0; c < 4; c++)
      beamError = Math.max(beamError, Math.abs(beams[i * 4 + c] - expected[c]));
  }
  report.checks.submergedDirectBeam = {
    samples: 32,
    maximumTransferError: beamError,
    scope:
      "Flat-interface Fresnel power, Snell direction and RGB Beer attenuation; not full curved-interface light transport",
  };
  ensure(
    beamError < 2e-6,
    "Submerged direct beam violates analytical energy/attenuation reference",
  );
  beamPass.dispose();
  beamRT.dispose();
  // Occlusion is inside solarReflection, not a convention callers can forget.
  const shadow = dataTexture(new Float32Array([0, 0, 0, 1]), 1, 1),
    sky = dataTexture(new Float32Array([0.2, 0.2, 0.2, 1]), 1, 1),
    sun = new THREE.Vector3(0.3, 0.8, 0.4).normalize();
  const sunUniforms = {
    ...engine.shared,
    uSun: U(sun),
    uSunColor: U(new THREE.Vector3(1, 1, 1)),
    uSky: U(sky),
    uShadowDepth: U(shadow),
    uShadowMatrix: U(new THREE.Matrix4()),
  };
  const sunPass = new Pass(
      waterFragment.slice(0, waterFragment.indexOf("void main(){")) +
        `void main(){vec3 V=vec3(0.,1.,0.),N=normalize(V+uSun);fragColor=vec4(solarReflection(vec3(0.),N,V,.04),1.);motion=vec4(0.);}`,
      sunUniforms,
    ),
    sunRT = target(1, 1);
  sunPass.run(r, sunRT);
  const dark = read(sunRT);
  shadow.image.data[0] = 1;
  shadow.needsUpdate = true;
  sunPass.run(r, sunRT);
  const lit = read(sunRT);
  report.checks.waterSolarOcclusion = {
    blockedRadiance: Array.from(dark.slice(0, 3)),
    unblockedRadiance: Array.from(lit.slice(0, 3)),
    scope:
      "Actual water solar-reflection function with a controlled shadow-depth fixture",
  };
  ensure(
    dark[0] === 0 && dark[1] === 0 && dark[2] === 0 && lit[0] > 0.001,
    "Water sun lobe ignores geometric occlusion",
  );
  sunPass.dispose();
  sunRT.dispose();
  shadow.dispose();
  sky.dispose();
  engine.setPreset("storm");
  engine.patch.reset();
  const lattice = [];
  for (let z = 0; z < 96; z++)
    for (let x = 0; x < 96; x++)
      lattice.push([(x / 95 - 0.5) * 192, (z / 95 - 0.5) * 192]);
  let minimum = Infinity;
  const sampleTimes = [57, 62, 74, 91, 124];
  for (const time of sampleTimes) {
    engine.ocean.step(time);
    const result = engine.ocean.query(
      lattice,
      engine.patch.texture,
      engine.patch.size,
    );
    for (const p of result) {
      ensure(
        Number.isFinite(p.height) && Number.isFinite(p.jacobian),
        "Nonfinite composed ocean",
      );
      minimum = Math.min(minimum, p.jacobian);
    }
  }
  report.checks.composedStormSurface = {
    pointsPerTime: lattice.length,
    times: sampleTimes,
    minimumSampledJacobian: minimum,
    scope: "Sampled field check, not a proof between samples or for every time",
  };
  ensure(
    minimum > 0,
    "Composed choppy surface folds in regression sample: " + minimum,
  );
  const normalCamera = engine.currentCamera;
  engine.setPreset("glass");
  engine.command("impulse", { x: 0, z: -5, height: 0.3, radius: 0.8, foam: 0 });
  for (let i = 0; i < 8; i++) engine.fixedStep();
  const before = read(engine.patch.a),
    tick = engine.tick;
  engine.setCamera({ eye: [90, 30, 70], target: [0, 0, 0], fov: 52 });
  engine.render();
  engine.setCamera(normalCamera);
  engine.render();
  const after = read(engine.patch.a);
  ensure(
    tick === engine.tick && before.every((v, i) => v === after[i]),
    "Render/camera movement changed physical state",
  );
  report.checks.cameraIndependentPhysics = { tick, bitwiseEqualState: true };
  engine.setPreset(old);
  engine.setCamera(normalCamera);
  report.passed = true;
  return report;
}



return {validateRepairs};
})();
