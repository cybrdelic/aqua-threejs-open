__M["src/math.js"]=(()=>{

/** Deterministic numerics; world units are metres and seconds. */
const G = 9.81;
const TAU = 2 * Math.PI;
const clamp = (x, a, b) => Math.min(b, Math.max(a, x));
const lerp = (a, b, t) => a + (b - a) * t;
const smoothstep = (a, b, x) => {
  const t = clamp((x - a) / (b - a), 0, 1);
  return t * t * (3 - 2 * t);
};
function mulberry32(seed) {
  return () => {
    let t = (seed += 0x6d2b79f5);
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
function gaussian(rng) {
  const u = Math.max(1e-12, rng());
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(TAU * rng());
}
function dispersion(k, depth = 200) {
  return Math.sqrt(G * k * Math.tanh(k * depth));
}
function groupVelocity(k, depth = 200) {
  if (k < 1e-10) return Math.sqrt(G * depth);
  const w = dispersion(k, depth),
    h = Math.tanh(k * depth);
  return (G * (h + k * depth * (1 - h * h))) / (2 * w);
}
function fresnelDielectric(cosI, etaI = 1, etaT = 1.333) {
  cosI = clamp(Math.abs(cosI), 0, 1);
  const sinT2 = (etaI / etaT) ** 2 * (1 - cosI * cosI);
  if (sinT2 >= 1) return 1;
  const ct = Math.sqrt(1 - sinT2),
    rs = (etaI * cosI - etaT * ct) / (etaI * cosI + etaT * ct),
    rp = (etaT * cosI - etaI * ct) / (etaT * cosI + etaI * ct);
  return 0.5 * (rs * rs + rp * rp);
}
const V = {
  add: (a, b) => a.map((x, i) => x + b[i]),
  sub: (a, b) => a.map((x, i) => x - b[i]),
  scale: (a, b) => a.map((x) => x * b),
  dot: (a, b) => a.reduce((s, x, i) => s + x * b[i], 0),
  cross: (a, b) => [
    a[1] * b[2] - a[2] * b[1],
    a[2] * b[0] - a[0] * b[2],
    a[0] * b[1] - a[1] * b[0],
  ],
  norm: (a) => {
    const n = Math.hypot(...a) || 1;
    return a.map((x) => x / n);
  },
};
function perspective(fovy, aspect, near, far) {
  const f = 1 / Math.tan(fovy / 2),
    nf = 1 / (near - far);
  return new Float32Array([
    f / aspect,
    0,
    0,
    0,
    0,
    f,
    0,
    0,
    0,
    0,
    (far + near) * nf,
    -1,
    0,
    0,
    2 * far * near * nf,
    0,
  ]);
}
function lookAt(eye, target) {
  const z = V.norm(V.sub(eye, target)),
    x = V.norm(V.cross([0, 1, 0], z)),
    y = V.cross(z, x);
  return new Float32Array([
    x[0],
    y[0],
    z[0],
    0,
    x[1],
    y[1],
    z[1],
    0,
    x[2],
    y[2],
    z[2],
    0,
    -V.dot(x, eye),
    -V.dot(y, eye),
    -V.dot(z, eye),
    1,
  ]);
}
function matmul(a, b) {
  const out = new Float32Array(16);
  for (let c = 0; c < 4; c++)
    for (let r = 0; r < 4; r++)
      for (let k = 0; k < 4; k++) out[c * 4 + r] += a[k * 4 + r] * b[c * 4 + k];
  return out;
}
function cameraBasis(eye, target) {
  const forward = V.norm(V.sub(target, eye)),
    right = V.norm(V.cross(forward, [0, 1, 0])),
    up = V.cross(right, forward);
  return { forward, right, up };
}



return {G,TAU,clamp,lerp,smoothstep,mulberry32,gaussian,dispersion,groupVelocity,fresnelDielectric,V,perspective,lookAt,matmul,cameraBasis};
})();
