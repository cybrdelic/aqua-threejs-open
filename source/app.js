__M["src/app.js"]=(async ()=>{

const {validateRepairs}=__M["src/repair-validation.js"];
const { WaterEngine }=__M["src/engine.js"];
const { PRESETS }=__M["src/config.js"];
const { validateGPU }=__M["src/validation.js"];
const { clamp }=__M["src/math.js"];
const $ = (s) => document.querySelector(s),
  params = new URLSearchParams(window.__QUERY__ || location.search),
  capture = params.has("capture");
const mobile = matchMedia("(pointer: coarse)").matches || innerWidth < 700;
function displaySize() {
  const dpr = Math.min(devicePixelRatio || 1, mobile ? 1.15 : 1.5);
  const budget = mobile ? 850000 : 2800000;
  const factor = Math.min(dpr, Math.sqrt(budget / Math.max(1,innerWidth*innerHeight)));
  return [Math.max(2,Math.round(innerWidth*factor)),Math.max(2,Math.round(innerHeight*factor))];
}
const [width,height] = capture ? [+(params.get("width")||1920),+(params.get("height")||1080)] : displaySize();
let paused = false,
  viewMode = "film",
  yaw = 0.65,
  elevation = 11,
  radius = 38,
  pitch = .24,
  orbitTarget = [0,-.3,-9],
  last = 0,
  clock = 0;
try {
  const engine = (window.engine = new WaterEngine($("#water"), width, height, {
    grid: +(params.get("grid") || ((capture || !mobile) && params.get("quality")!=="low" ? 256 : 128)),
    high: params.get("quality") !== "low" && (capture || !mobile),
  }));
  await engine.initialize();
  const key = params.get("scene") || "blue";
  engine.setPreset(PRESETS[key] ? key : "blue");
  for (const [key, p] of Object.entries(PRESETS)) {
    $("#scene").add(new Option(p.name, key));
  }
  $("#scene").value = engine.sceneKey;
  function labels() {
    const p = engine.preset;
    $("#scene-title").textContent = p.name;
    $("#description").textContent = p.description;
    $("#extinction").value = 1;
    $("#extinction-value").textContent = "1.00×";
  }
  function preset(k) {
    engine.setPreset(k);
    viewMode = "film";$("#view").value="film";
    clock = 0;
    labels();
    $("#scene").value = k;
    for (const box of document.querySelectorAll("[data-flag]"))
      box.checked = engine.flags[box.dataset.flag];
  }
  function camera(t) {
    const p = engine.preset;
    if(viewMode==='film'&&p.bubbleEmitter){engine.setCamera({eye:[3.7,-2.4,3.8],target:[1,-1.5,-2],fov:58});return;}
    if (viewMode === "under") {
      engine.setCamera({
        eye: [8, -2.3, 12],
        target: [-12, -0.15, -17],
        fov: 66,
      });
      return;
    }
    if (viewMode === "top") {
      engine.setCamera({ eye: [1, 42, 8], target: [0, 0, -8], fov: 54 });
      return;
    }
    if(viewMode === "orbit"){ applyOrbit(); return; }
    const phase = Math.sin(t * 0.045);
    if (p.boat) {
      const b = engine.dynamics.bodies[0],
        x = b?.position.x || 0,
        z = b?.position.z || 0;
      engine.setCamera({
        eye: [x + 13, 5.5, z + 17],
        target: [x, 0, z],
        fov: 49,
      });
    } else if (p.buoys)
      engine.setCamera({
        eye: [11 + phase * 6, 6, 16],
        target: [0, 0.2, -5],
        fov: 45,
      });
    else if (p.terrain)
      engine.setCamera({
        eye: [17 + phase * 7, 7.4 + Math.sin(t * 0.07), 24 - 4 * Math.sin(t * .045)],
        target: [-10, -0.4, -17],
        fov: 51,
      });
    else
      engine.setCamera({
        eye: [
          14 - 7 * Math.sin(t * .045),
          p.wind > 15 ? 7.8 : 4.5,
          25 - 6 * Math.sin(t * .045),
        ],
        target: [-46, -0.1, -68],
        fov: 54,
      });
  }
  $("#scene").onchange = (e) => preset(e.target.value);
  $("#view").onchange = (e) => {
    viewMode = e.target.value;
    engine.post.reset();
  };
  $("#pause").onclick = () => {
    paused = !paused;
    $("#pause").textContent = paused ? "Play" : "Pause";
  };
  $("#reset").onclick = () => preset(engine.sceneKey);
  $("#impulse").onclick = () =>
    engine.command("impulse", {
      x: 0,
      z: -5,
      height: 0.75,
      radius: 1.4,
      foam: 0.5,
    });
  $("#inspect").onclick = () => {
    $("#diagnostics").classList.toggle("open");
    $("#report").textContent = JSON.stringify(
      engine.diagnostics(true),
      null,
      2,
    );
  };
  for (const box of document.querySelectorAll("[data-flag]"))
    box.onchange = () => {
      engine.command("flag", { name: box.dataset.flag, value: box.checked });
      engine.post.reset();
    };
  $("#extinction").oninput = (e) => {
    const scale = +e.target.value;
    engine.command("extinction", { scale });
    $("#extinction-value").textContent = scale.toFixed(2) + "×";
    engine.post.reset();
  };
  // One shared dolly implementation for wheel, buttons, keyboard and touch.
  // There is no application maximum radius. IEEE finite-number validation is
  // not a user-facing zoom cap; the clip planes / ocean coverage scale with it.
  function applyOrbit(){
    const h=radius*Math.cos(pitch);
    engine.setCamera({eye:[orbitTarget[0]+Math.sin(yaw)*h,orbitTarget[1]+Math.sin(pitch)*radius,orbitTarget[2]+Math.cos(yaw)*h],target:orbitTarget,fov:52});
    const distanceLabel=document.querySelector('#zoom-distance');
    if(distanceLabel)distanceLabel.textContent=radius>=1000?(radius/1000).toLocaleString(undefined,{maximumFractionDigits:2})+' km':radius.toFixed(1)+' m';
  }
  function enterOrbit(){
    if(viewMode!=='orbit'){
      const c=engine.currentCamera;
      orbitTarget=c.target.slice();
      const x=c.eye[0]-c.target[0],y=c.eye[1]-c.target[1],z=c.eye[2]-c.target[2];
      radius=Math.hypot(x,y,z);yaw=Math.atan2(x,z);pitch=Math.atan2(y,Math.hypot(x,z));
      viewMode='orbit';$('#view').value='orbit';
    }
  }
  function zoomBy(factor){
    if(!Number.isFinite(factor)||factor<=0)return;
    enterOrbit();const next=radius*factor;
    if(Number.isFinite(next))radius=Math.max(.25,next);
    applyOrbit();engine.post.reset();
  }
  function setOrbit(options={}){
    enterOrbit();
    if(options.distance!==undefined){if(!Number.isFinite(options.distance)||options.distance<=0)throw new RangeError('Invalid orbit distance');radius=Math.max(.25,options.distance);}
    if(options.pitch!==undefined)pitch=clamp(options.pitch,-Math.PI/2+.005,Math.PI/2-.005);
    if(options.yaw!==undefined)yaw=options.yaw;
    if(options.target)orbitTarget=options.target.slice();
    applyOrbit();
  }
  const pointers=new Map();
  const pinchDistance=()=>{const p=[...pointers.values()];return p.length>=2?Math.hypot(p[0][0]-p[1][0],p[0][1]-p[1][1]):0;};
  $('#water').addEventListener('pointerdown',e=>{
    e.preventDefault();enterOrbit();pointers.set(e.pointerId,[e.clientX,e.clientY]);$('#water').setPointerCapture(e.pointerId);
  });
  $('#water').addEventListener('pointermove',e=>{
    if(!pointers.has(e.pointerId))return;
    const previous=pointers.get(e.pointerId),before=pinchDistance();pointers.set(e.pointerId,[e.clientX,e.clientY]);
    if(pointers.size>=2){const after=pinchDistance();if(before>2&&after>2)zoomBy(before/after);}
    else {yaw-=(e.clientX-previous[0])*.004;pitch=clamp(pitch+(e.clientY-previous[1])*.0035,-Math.PI/2+.005,Math.PI/2-.005);applyOrbit();}
  });
  for(const name of ['pointerup','pointercancel','lostpointercapture'])$('#water').addEventListener(name,e=>pointers.delete(e.pointerId));
  $('#water').addEventListener('wheel',e=>{e.preventDefault();const pixels=e.deltaY*(e.deltaMode===1?16:e.deltaMode===2?innerHeight:1);zoomBy(Math.exp(clamp(pixels*.0015,-4,4)));},{passive:false});
  $('#zoom-out').onclick=()=>zoomBy(1.8);
  $('#zoom-in').onclick=()=>zoomBy(1/1.8);
  $('#home-camera').onclick=()=>{viewMode='film';$('#view').value='film';camera(clock);engine.post.reset();};
  $("#water").addEventListener("dblclick", (e) => {
    const rect = $("#water").getBoundingClientRect(),
      p = engine.pickWater(
        ((e.clientX - rect.left) / rect.width) * 2 - 1,
        1 - ((e.clientY - rect.top) / rect.height) * 2,
      );
    if (p)
      engine.command("impulse", {
        x: p.x,
        z: p.z,
        height: 0.7,
        radius: 1.4,
        foam: 0.4,
      });
  });
  document.addEventListener("keydown", (e) => {
    if (["INPUT", "SELECT"].includes(e.target.tagName)) return;
    if(e.key==='-'||e.key==='_')zoomBy(1.35);
    if(e.key==='+'||e.key==='=')zoomBy(1/1.35);
    if(e.key==='Home')$('#home-camera').click();
    if (e.code === "Space") {
      e.preventDefault();
      $("#pause").click();
    }
    if (e.key.toLowerCase() === "h")
      document.body.classList.toggle("hidden-ui");
    if (e.key.toLowerCase() === "n") {
      engine.debug = (engine.debug + 1) % 7;
      engine.post.reset();
    }
    if (e.key.toLowerCase() === "u") {
      viewMode = viewMode === "under" ? "film" : "under";
      $("#view").value = viewMode;
      engine.post.reset();
    }
  });
  $("#journal").onclick = () => {
    const url = URL.createObjectURL(
        new Blob([JSON.stringify({...engine.journal.export(),model:"cybr-water-2.4",grid:engine.grid}, null, 2)], {
          type: "application/json",
        }),
      ),
      a = document.createElement("a");
    a.href = url;
    a.download = "cybr-water-replay.json";
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  };
  $("#record").onclick = () => {
    if (typeof MediaRecorder === "undefined" || !("captureStream" in $("#water"))) {
      alert("Video recording is not available in this browser. Use the separately supplied MP4 or the source capture script.");
      return;
    }
    const mime = [
      "video/webm;codecs=vp9",
      "video/webm;codecs=vp8",
      "video/webm",
    ].find((s) => MediaRecorder.isTypeSupported(s));
    if (!mime) {
      alert("Recording is not supported by this browser");
      return;
    }
    const stream = $("#water").captureStream(30),
      rec = new MediaRecorder(stream, {
        mimeType: mime,
        videoBitsPerSecond: 24000000,
      }),
      chunks = [];
    rec.ondataavailable = (e) => chunks.push(e.data);
    rec.onstop = () => {
      const u = URL.createObjectURL(new Blob(chunks, { type: mime })),
        a = document.createElement("a");
      a.href = u;
      a.download = "cybr-water-2.4-" + engine.sceneKey + ".webm";
      a.click();
      setTimeout(() => URL.revokeObjectURL(u), 30000);
      $("#record").textContent = "Record 20 s";
    };
    rec.start();
    $("#record").textContent = "Recording…";
    setTimeout(() => rec.stop(), 20000);
  };
  function tick(ms) {
    const dt = last ? Math.min(0.1, (ms - last) / 1000) : 1 / 60;
    last = ms;
    if (!paused) {
      engine.advance(dt);
      clock += dt;
    }
    camera(clock);
    engine.render();
    if (engine.frameCount % 30 === 0) {
      $("#backend").textContent = "THREE.JS r180 / GPU FFT";
      $("#stats").textContent =
        `${engine.width} × ${engine.height} · ${engine.tick} physical ticks · ${engine.particles.counts.spray} spray / ${engine.particles.counts.bubbles} bubbles · ${engine.rain.impacts} rain impacts`;
      if ($("#diagnostics").classList.contains("open"))
        $("#report").textContent = JSON.stringify(
          engine.diagnostics(),
          null,
          2,
        );
    }
    requestAnimationFrame(tick);
  }
  window.app = {
    engine,
    exportReplay: () => ({...engine.journal.export(),model:"cybr-water-2.4",grid:engine.grid}),
    loadReplay: (doc) => {
      engine.loadReplay(doc);
      clock = 0;
      labels();
      $("#scene").value = engine.sceneKey;
      for (const box of document.querySelectorAll("[data-flag]"))
        box.checked = engine.flags[box.dataset.flag];
    },
    setPreset: preset,
    setOrbit,zoomBy,
    orbitState:()=>({distance:radius,pitch,yaw,target:orbitTarget.slice(),maxDistance:Infinity,viewMode}),
    frame: (dt = 1 / 24) => {
      engine.advance(dt);
      engine.render();
    },
    setCamera: (c) => engine.setCamera(c),
    render: () => engine.render(),
    diagnostics: (deep) => engine.diagnostics(deep),
    verifyGPU: () => validateGPU(engine),
    verifyRepairs:()=>validateRepairs(engine),
    label: (title, caption, num = "CYBR / WATER 2.4") => {
      $("#shot-title").textContent = title;
      $("#shot-caption").textContent = caption;
      $("#shot-number").textContent = num;
    },
    setDebug: (v) => {
      engine.debug = v;
      engine.post.reset();
    },
  };
  labels();
  camera(0);
  engine.render();
  $("#loading").remove();
  $("#backend").textContent = "THREE.JS r180 / GPU FFT";
  if (capture) document.body.classList.add("capture");
  if (params.has("clean")) document.body.classList.add("hidden-ui");
  window.__READY__ = true;
  if (!capture) requestAnimationFrame(tick);
  window.addEventListener("resize", () => {
    if (!capture) {
      engine.resize(...displaySize());
    }
  });
  $("#water").addEventListener("webglcontextlost", (e) => {
    e.preventDefault();
    paused = true;
    $("#error").hidden = false;
    $("#error").textContent =
      "The graphics context was lost. Reload to restart.";
  });
} catch (e) {
  window.__ERROR__ = String(e);
  console.error(e);
  $("#error").textContent = e.stack || String(e);
  $("#error").hidden = false;
  $("#loading")?.remove();
}



return {};
})();