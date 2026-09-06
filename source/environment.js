__M["src/environment.js"]=(()=>{

const { THREE, uniform:U }=__M["src/gpu.js"];
const { directBeamGLSL }=__M["src/light-transport.js"];
const environmentGLSL = `
const float PI=3.141592653589793;
uniform highp sampler2D uSky,uMicro;uniform vec3 uSun,uSunColor,uEye;uniform float uTime,uExposure;
uniform vec3 uAbsorption,uScattering,uWaterLight;uniform vec4 uBed;
uniform vec3 uSkySH[9];uniform float uShutter,uSkyYaw;
vec3 skyLocalDirection(vec3 d){float c=cos(uSkyYaw),s=sin(uSkyYaw);return vec3(c*d.x-s*d.z,d.y,s*d.x+c*d.z);}
vec3 skyDiffuse(vec3 n){n=skyLocalDirection(normalize(n));return max(vec3(0.),uSkySH[0]*.282095+uSkySH[1]*(.488603*n.y)+uSkySH[2]*(.488603*n.z)+uSkySH[3]*(.488603*n.x)+uSkySH[4]*(1.092548*n.x*n.y)+uSkySH[5]*(1.092548*n.y*n.z)+uSkySH[6]*(.315392*(3.*n.z*n.z-1.))+uSkySH[7]*(1.092548*n.x*n.z)+uSkySH[8]*(.546274*(n.x*n.x-n.y*n.y)));}
vec3 waterInscatter(vec3 direction,float distance){
 vec3 ext=uAbsorption+uScattering,albedo=uScattering/max(ext,vec3(1e-6));
 float mu=dot(normalize(direction),uSun),g=.64;
 float phase=(1.-g*g)/pow(max(.03,1.+g*g-2.*g*mu),1.5);
 vec3 incident=uWaterLight*(.60+.10*phase);
 return incident*albedo*(1.-exp(-ext*max(0.,distance)));
}
vec2 environmentUV(vec3 d){d=skyLocalDirection(normalize(d));return vec2(atan(d.z,d.x)/(2.*PI)+.5,acos(clamp(d.y,-1.,1.))/PI);}
vec3 environment(vec3 d){return texture(uSky,environmentUV(d)).rgb;}
vec3 environmentRough(vec3 d,float rough){return textureLod(uSky,environmentUV(d),clamp(rough*9.,0.,6.)).rgb;}
float solarVisibility(){return texture(uSky,environmentUV(uSun)).a;}
float noise2(vec2 p){return texture(uMicro,p).r;}
float bedHeight(vec2 p){float h=-uBed.x-uBed.y*35.*tanh(p.x/35.)-uBed.z*35.*tanh(p.y/35.);
 if(uBed.w>.5){h+=.18*sin(p.x*.27+sin(p.y*.1))+.14*sin(p.y*.36);float bank=1.-smoothstep(-66.,-25.,p.y);float headlands=exp(-pow((p.x+29.)/16.,2.))+exp(-pow((p.x-33.)/19.,2.));h+=bank*smoothstep(-128.,-83.,p.y)*exp(-pow(abs(p.x)/83.,4.))*(3.+11.*headlands);}
 return h;}
float dielectric(float ci,float ni,float nt){ci=clamp(abs(ci),0.,1.);float s2=pow(ni/nt,2.)*(1.-ci*ci);if(s2>=1.)return 1.;float ct=sqrt(1.-s2);float rs=(ni*ci-nt*ct)/(ni*ci+nt*ct);float rp=(nt*ci-ni*ct)/(nt*ci+ni*ct);return .5*(rs*rs+rp*rp);}
vec3 transmittance(float d){return exp(-(uAbsorption+uScattering)*max(0.,d));}
${directBeamGLSL}
`;
function bedHeightJS(x, z, p) {
  let h = -p[0] - p[1] * 35 * Math.tanh(x / 35) - p[2] * 35 * Math.tanh(z / 35);
  if (p[3] > 0.5) {
    h +=
      0.18 * Math.sin(x * 0.27 + Math.sin(z * 0.1)) + 0.14 * Math.sin(z * 0.36);
    let b = Math.max(0, Math.min(1, (z + 66) / 41));
    b = 1 - b * b * (3 - 2 * b);
    let tail = Math.max(0,Math.min(1,(z+128)/45)); tail=tail*tail*(3-2*tail);
    h +=
      b * tail * Math.exp(-((Math.abs(x)/83)**4)) *
      (3 +
        11 *
          (Math.exp(-(((x + 29) / 16) ** 2)) +
            Math.exp(-(((x - 33) / 19) ** 2))));
  }
  return h;
}
async function assetBytes(path) {
  if (window.__ASSETS__?.[path] || window.__LOAD_ASSET__) {
    const e = window.__ASSETS__?.[path] || (await window.__LOAD_ASSET__(path));
    const raw = Uint8Array.from(atob(e.data), (c) => c.charCodeAt(0));
    return e.gzip
      ? new Uint8Array(
          await new Response(
            new Blob([raw])
              .stream()
              .pipeThrough(new DecompressionStream("gzip")),
          ).arrayBuffer(),
        )
      : raw;
  }
  const base = window.__ASSET_BASE__ || "";
  const r = await fetch(base + path);
  if (!r.ok) throw new Error(`Cannot load ${path}: ${r.status}`);
  return new Uint8Array(await r.arrayBuffer());
}
async function loadEnvironment() {
  const skies = {};
  for (const name of ["dawn", "blue", "storm"]) {
    const raw = await assetBytes("assets/" + name + ".rgba16f");
    const data = new Uint16Array(
      raw.buffer,
      raw.byteOffset,
      raw.byteLength / 2,
    );
    const tex = new THREE.DataTexture(
      data,
      2048,
      1024,
      THREE.RGBAFormat,
      THREE.HalfFloatType,
    );
    tex.minFilter = THREE.LinearMipmapLinearFilter;
    tex.magFilter = THREE.LinearFilter;
    tex.wrapS = THREE.RepeatWrapping;
    tex.wrapT = THREE.ClampToEdgeWrapping;
    tex.generateMipmaps = true;
    tex.needsUpdate = true;
    tex.userData.irradiance = skyCoefficients(data, 2048, 1024);
    skies[name] = tex;
  }
  const read = async (name) => {
    const data = await assetBytes("assets/" + name);
    const im = await createImageBitmap(
      new Blob([data], {
        type: name.endsWith(".jpg") ? "image/jpeg" : "image/png",
      }),
    );
    const tex = new THREE.Texture(im);
    tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
    tex.minFilter = THREE.LinearMipmapLinearFilter;
    tex.magFilter = THREE.LinearFilter;
    tex.generateMipmaps = true;
    tex.anisotropy = 8;
    tex.needsUpdate = true;
    return tex;
  };
  return {
    skies,
    micro: await read("micro.png"),
    foam: await read("foam.png"),
    rockDiffuse: await read("rock_face_diff.jpg"),
    rockNormal: await read("rock_face_nor_gl.jpg"),
    sandDiffuse: await read("damp_sand_diff.jpg"),
    sandNormal: await read("damp_sand_nor_gl.jpg"),
  };
}
function sharedEnvironment(assets) {
  return {
    uRockDiffuse: U(assets.rockDiffuse),
    uRockNormal: U(assets.rockNormal),
    uSandDiffuse: U(assets.sandDiffuse),
    uSandNormal: U(assets.sandNormal),
    uSky: U(assets.skies.blue),
    uMicro: U(assets.foam),
    uSkySH: U(assets.skies.blue.userData.irradiance),
    uShutter: U(1 / 48),
    uSkyYaw: U(0),
    uSun: U(new THREE.Vector3(-0.4, 0.48, -0.78).normalize()),
    uSunColor: U(new THREE.Vector3(2.3, 2.25, 2.12)),
    uEye: U(new THREE.Vector3()),
    uTime: U(0),
    uExposure: U(1.05),
    uAbsorption: U(new THREE.Vector3(0.19, 0.047, 0.021)),
    uScattering: U(new THREE.Vector3(0.009, 0.017, 0.021)),
    uWaterLight: U(new THREE.Vector3(0.1, 0.4, 0.48)),
    uBed: U(new THREE.Vector4(5, 0.07, 0.035, 0)),
  };
}

/** Cosine-convolved radiance SH; the division by pi is in the band factors. */
function skyCoefficients(half, width, height) {
  const c = Array.from({ length: 9 }, () => new THREE.Vector3());
  const W = 128,
    H = 64,
    dOmega = (2 * Math.PI * Math.PI) / (W * H);
  for (let y = 0; y < H; y++)
    for (let x = 0; x < W; x++) {
      const theta = ((y + 0.5) / H) * Math.PI,
        phi = ((x + 0.5) / W - 0.5) * 2 * Math.PI;
      const nx = Math.sin(theta) * Math.cos(phi),
        ny = Math.cos(theta),
        nz = Math.sin(theta) * Math.sin(phi);
      const basis = [
        0.282095,
        0.488603 * ny,
        0.488603 * nz,
        0.488603 * nx,
        1.092548 * nx * ny,
        1.092548 * ny * nz,
        0.315392 * (3 * nz * nz - 1),
        1.092548 * nx * nz,
        0.546274 * (nx * nx - ny * ny),
      ];
      const px = Math.min(width - 1, Math.floor(((x + 0.5) / W) * width)),
        py = Math.min(height - 1, Math.floor(((y + 0.5) / H) * height)),
        i = (py * width + px) * 4;
      const rgb = new THREE.Vector3(
        THREE.DataUtils.fromHalfFloat(half[i]),
        THREE.DataUtils.fromHalfFloat(half[i + 1]),
        THREE.DataUtils.fromHalfFloat(half[i + 2]),
      );
      for (let k = 0; k < 9; k++)
        c[k].addScaledVector(
          rgb,
          basis[k] *
            Math.sin(theta) *
            dOmega *
            (k === 0 ? 1 : k < 4 ? 2 / 3 : 1 / 4),
        );
    }
  return c;
}



return {environmentGLSL,bedHeightJS,assetBytes,loadEnvironment,sharedEnvironment,skyCoefficients};
})();
