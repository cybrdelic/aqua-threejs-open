__M["src/validation.js"]=(()=>{

/** Executable GPU checks, invoked before recording. These are numerical
 * implementation checks, not experimental validation of a complete ocean. */
function validateGPU(engine) {
  const reports = {};
  const old = engine.sceneKey;
  engine.setPreset("storm");
  reports.spectral = engine.ocean.verify(13.27);
  engine.patch.reset();
  engine.patch.impulse(0, 0, 0.4, 1, 0, [100, 0]);
  engine.patch.step(1 / 60);
  reports.zeroAlphaImpulse = engine.patch.diagnostics();
  // Measure the source target, not the peak after propagation. With the repaired
  // 300 m bathymetry the physical gravity-wave speed and CFL substeps differ.
  const sourceData=new Float32Array(engine.patch.n*engine.patch.n*4);
  engine.renderer.readRenderTargetPixels(engine.patch.sources,0,0,engine.patch.n,engine.patch.n,sourceData);
  let sourcePeak=0;for(let i=0;i<sourceData.length;i+=4)sourcePeak=Math.max(sourcePeak,Math.abs(sourceData[i]));
  reports.heightImpulseSourcePeak=sourcePeak;
  if(sourcePeak<.3||!reports.zeroAlphaImpulse.finite)
    throw new Error("Numerical source suppressed or nonfinite propagated state");
  const data = new Float32Array(engine.patch.n * engine.patch.n * 4);
  engine.renderer.readRenderTargetPixels(
    engine.patch.a,
    0,
    0,
    engine.patch.n,
    engine.patch.n,
    data,
  );
  let px = 0;
  for (let i = 0; i < data.length; i += 4)
    px += data[i + 1] * engine.patch.dx ** 2 * 1025 * engine.patch.bedData[i+1];
  reports.returnedHorizontalMomentum = px;
  if (!(px > 80 && px < 120))
    throw new Error("Horizontal impulse normalization failed: " + px);
  const doc = {
    format: "cybr-water-replay",
    version: 1,
    seed: 91317,
    scene: "glass",
    step: 1 / 60,
    events: [
      {
        tick: 10,
        type: "impulse",
        payload: { x: 0, z: -5, height: 0.4, radius: 1, foam: 0.2 },
      },
      {
        tick: 35,
        type: "impulse",
        payload: { x: 2, z: -6, height: 0.3, radius: 0.8, foam: 0.1 },
      },
    ],
  };
  const checksum = () => {
    const d = new Float32Array(engine.patch.n * engine.patch.n * 4);
    engine.renderer.readRenderTargetPixels(
      engine.patch.a,
      0,
      0,
      engine.patch.n,
      engine.patch.n,
      d,
    );
    let h = 2166136261;
    for (const b of new Uint32Array(d.buffer)) h = Math.imul(h ^ b, 16777619);
    return (h >>> 0).toString(16);
  };
  const hashes = [];
  for (let trial = 0; trial < 2; trial++) {
    engine.loadReplay(doc);
    for (let i = 0; i < 90; i++) engine.fixedStep();
    hashes.push(checksum());
  }
  reports.replay = {
    ticks: 90,
    stateHashes: hashes,
    equal: hashes[0] === hashes[1],
    scope: "same browser/backend and settings",
  };
  if (!reports.replay.equal) throw new Error("Fixed-tick replay mismatch");
  engine.setPreset(old);
  return reports;
}



return {validateGPU};
})();
