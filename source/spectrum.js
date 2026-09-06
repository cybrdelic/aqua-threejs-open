__M["src/spectrum.js"]=(()=>{

const {
  G,
  TAU,
  dispersion,
  groupVelocity,
  mulberry32,
  gaussian,
}=__M["src/math.js"];
const { FFT }=__M["src/fft.js"];
const BANDS = [
  { length: 768, minWave: 16, maxWave: 769 },
  { length: 96, minWave: 2, maxWave: 16 },
  { length: 12, minWave: 0.25, maxWave: 2 },
];
/** Reproducible JONSWAP coefficients. All units are metres and seconds.
 * k-bands do not overlap; horizontal displacement is an explicit choppy closure.
 * CPU reference and GPU evolution consume the identical initial coefficients.
 */
class Spectrum {
  constructor(n, preset, seed = 91317) {
    this.n=n; this.preset=preset; this.seed=seed;
    const sea=preset.seaSystems || [
      {period:preset.period, direction:preset.direction, fraction:1, gamma:3.3, spread:12}
    ];
    const totalFraction=sea.reduce((a,c)=>a+c.fraction,0);
    if(!(totalFraction>0))throw new RangeError("Sea-system energy must be positive");
    const sums=sea.map(()=>0), shapes=[];
    this.bands=BANDS.map((band,index)=>{
      const h0=new Float32Array(n*n*4), powers=sea.map(()=>new Float64Array(n*n));
      for(let z=0;z<n;z++)for(let x=0;x<n;x++){
        const kx=(x<=n/2?x:x-n)*TAU/band.length,kz=(z<=n/2?z:z-n)*TAU/band.length;
        const k=Math.hypot(kx,kz),wl=TAU/(k||1e-12),w=dispersion(k,preset.depth),i=z*n+x;
        h0[i*4+2]=w;h0[i*4+3]=k;
        if(!k||x===n/2||z===n/2||wl<band.minWave||wl>=band.maxWave)continue;
        const theta=Math.atan2(kz,kx),dk=TAU/band.length;
        for(let c=0;c<sea.length;c++){
          const sys=sea[c],wp=TAU/sys.period,sigma=w<=wp?.07:.09;
          const peak=Math.exp(-.5*((w-wp)/(sigma*wp))**2);
          const angular=Math.exp((sys.spread||8)*(Math.cos(theta-sys.direction)-1));
          const power=G*G*w**-5*Math.exp(-1.25*(wp/w)**4)*(sys.gamma||3.3)**peak*angular*groupVelocity(k,preset.depth)/k*dk*dk;
          powers[c][i]=power;sums[c]+=power;
        }
      }
      shapes.push(powers);return {...band,h0,variance:0};
    });
    const variance=(preset.hs/4)**2;
    this.expectedVariance=0;
    for(let b=0;b<this.bands.length;b++){
      const band=this.bands[b],rng=mulberry32(seed+5989*b);
      for(let i=0;i<n*n;i++){
        let power=0;
        for(let c=0;c<sea.length;c++)power+=shapes[b][c][i]/Math.max(sums[c],1e-30)*sea[c].fraction/totalFraction*variance;
        band.h0[i*4]=gaussian(rng)*Math.sqrt(power*.25);
        band.h0[i*4+1]=gaussian(rng)*Math.sqrt(power*.25);
        band.variance+=power;
      }
      this.expectedVariance+=band.variance;
    }
    // Condition the sampled Gaussian realization on the requested total energy.
    // This avoids a small number of long-wave bins moving Hs by >10% by seed.
    let realized=0;
    for(const b of this.bands)for(let i=0;i<b.h0.length;i+=4)realized+=2*(b.h0[i]*b.h0[i]+b.h0[i+1]*b.h0[i+1]);
    const energyScale=realized>0?Math.sqrt(variance/realized):1;
    for(const b of this.bands)for(let i=0;i<b.h0.length;i+=4){b.h0[i]*=energyScale;b.h0[i+1]*=energyScale;}
    this.realizationScale=energyScale;
    this.systems=sea.map((c)=>({...c,energyFraction:c.fraction/totalFraction}));
  }
  /** Exact spatial and temporal spectral derivatives, not a finite-difference approximation. */
  reference(t, bandIndex = 0) {
    const b = this.bands[bandIndex],
      n = this.n,
      N = n * n,
      mask = n - 1,
      fft = new FFT(n);
    const fields = {};
    for (const name of [
      "h",
      "x",
      "z",
      "hx",
      "hz",
      "xx",
      "xz",
      "zz",
      "vx",
      "vy",
      "vz",
    ])
      fields[name] = { r: new Float32Array(N), i: new Float32Array(N) };
    const put = (name, j, r, i) => {
      fields[name].r[j] = r * N;
      fields[name].i[j] = i * N;
    };
    for (let z = 0; z < n; z++)
      for (let x = 0; x < n; x++) {
        const i = z * n + x,
          j = ((n - z) & mask) * n + ((n - x) & mask),
          a = i * 4,
          q = j * 4,
          w = b.h0[a + 2],
          k = b.h0[a + 3];
        const c = Math.cos(w * t),
          s = Math.sin(w * t),
          ar = b.h0[a],
          ai = b.h0[a + 1],
          br = b.h0[q],
          bi = b.h0[q + 1];
        const r = (ar + br) * c + (ai + bi) * s,
          im = (ai - bi) * c + (br - ar) * s;
        const vr = w * (-(ar + br) * s + (ai + bi) * c),
          vi = w * (-(ai - bi) * s + (br - ar) * c);
        const kx = ((x <= n / 2 ? x : x - n) * TAU) / b.length,
          kz = ((z <= n / 2 ? z : z - n) * TAU) / b.length,
          cp = this.preset.chop / (k || 1);
        put("h", i, r, im);
        put("x", i, -kx * cp * im, kx * cp * r);
        put("z", i, -kz * cp * im, kz * cp * r);
        put("hx", i, -kx * im, kx * r);
        put("hz", i, -kz * im, kz * r);
        put("xx", i, -kx * kx * cp * r, -kx * kx * cp * im);
        put("xz", i, -kx * kz * cp * r, -kx * kz * cp * im);
        put("zz", i, -kz * kz * cp * r, -kz * kz * cp * im);
        put("vx", i, -kx * cp * vi, kx * cp * vr);
        put("vy", i, vr, vi);
        put("vz", i, -kz * cp * vi, kz * cp * vr);
      }
    for (const f of Object.values(fields)) fft.transform2D(f.r, f.i);
    return fields;
  }
}



return {BANDS,Spectrum};
})();
