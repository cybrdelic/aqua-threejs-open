const __M={}; window.__MODULES__=__M;
__M["src/gpu.js"]=(()=>{

const THREE=window.THREE;

const quadVertex = `precision highp float;in vec3 position;out vec2 vUv;void main(){vUv=position.xy*.5+.5;gl_Position=vec4(position.xy,0.,1.);}`;
const quad = new THREE.BufferGeometry();
quad.setAttribute(
  "position",
  new THREE.Float32BufferAttribute([-1, -1, 0, 3, -1, 0, -1, 3, 0], 3),
);
function target(
  w,
  h,
  { count = 1, type = THREE.FloatType, linear = false, depth = false } = {},
) {
  const rt = new THREE.WebGLRenderTarget(w, h, {
    count,
    type,
    format: THREE.RGBAFormat,
    minFilter: linear ? THREE.LinearFilter : THREE.NearestFilter,
    magFilter: linear ? THREE.LinearFilter : THREE.NearestFilter,
    depthBuffer: depth,
    stencilBuffer: false,
    generateMipmaps: false,
  });
  for (const t of rt.textures) {
    t.colorSpace = THREE.NoColorSpace;
    t.generateMipmaps = false;
  }
  if (depth) {
    rt.depthTexture = new THREE.DepthTexture(w, h, THREE.UnsignedIntType);
    rt.depthTexture.format = THREE.DepthFormat;
  }
  return rt;
}
class Pass {
  constructor(fragment, uniforms = {}) {
    this.uniforms = uniforms;
    this.material = new THREE.RawShaderMaterial({
      glslVersion: THREE.GLSL3,
      vertexShader: quadVertex,
      fragmentShader: fragment,
      uniforms,
      depthTest: false,
      depthWrite: false,
      blending: THREE.NoBlending,
    });
    this.scene = new THREE.Scene();
    this.scene.add(new THREE.Mesh(quad, this.material));
    this.camera = new THREE.Camera();
  }
  run(renderer, rt, layer = 0) {
    renderer.setRenderTarget(rt, layer);
    renderer.render(this.scene, this.camera);
  }
  dispose() {
    this.material.dispose();
  }
}
function dataTexture(
  data,
  width,
  height,
  { linear = false, repeat = false } = {},
) {
  const t = new THREE.DataTexture(
    data,
    width,
    height,
    THREE.RGBAFormat,
    THREE.FloatType,
  );
  t.minFilter = t.magFilter = linear ? THREE.LinearFilter : THREE.NearestFilter;
  t.wrapS = t.wrapT = repeat ? THREE.RepeatWrapping : THREE.ClampToEdgeWrapping;
  t.needsUpdate = true;
  return t;
}
function uniform(value) {
  return { value };
}

/** Defined precision and interpolation for data textures on WebGL2 mobiles.
 * The interaction solver retains RGBA32F; it does not depend on an optional
 * float-linear extension for fractional surface/contact/advection samples.
 */
const bilinearGLSL = `
#ifndef CYBR_BILINEAR_2D
#define CYBR_BILINEAR_2D
vec4 sampleBilinear(highp sampler2D source,vec2 uv){
 ivec2 size=textureSize(source,0);vec2 p=uv*vec2(size)-.5;ivec2 i=ivec2(floor(p));vec2 f=fract(p);
 vec4 a=texelFetch(source,clamp(i,ivec2(0),size-1),0),b=texelFetch(source,clamp(i+ivec2(1,0),ivec2(0),size-1),0);
 vec4 c=texelFetch(source,clamp(i+ivec2(0,1),ivec2(0),size-1),0),d=texelFetch(source,clamp(i+ivec2(1,1),ivec2(0),size-1),0);
 return mix(mix(a,b,f.x),mix(c,d,f.x),f.y);
}
#endif
`;



return {quadVertex,target,Pass,dataTexture,uniform,bilinearGLSL,THREE};
})();
__M["src/ray-scene.js"]=(()=>{

const { THREE, dataTexture, uniform:U }=__M["src/gpu.js"];

/** A threaded, object-space triangle BVH. The same triangles are rasterized and
 * traced, including geometry outside the current camera's depth buffer. Dynamic
 * instances change only their rigid transforms; neither triangles nor physics
 * follow the viewer. Leaves contain at most six triangles. */
class TriangleBVH {
  constructor(triangles, leafSize = 6) {
    this.triangles = triangles;
    this.nodes = [];
    this.order = [];
    this.maxDepth = 0;
    if (triangles.length)
      this.build(
        triangles.map((_, i) => i),
        leafSize,
        0,
      );
  }
  build(ids, leafSize, depth) {
    this.maxDepth = Math.max(this.maxDepth, depth);
    const index = this.nodes.length;
    const lo = [Infinity, Infinity, Infinity],
      hi = [-Infinity, -Infinity, -Infinity];
    const cmin = [...lo],
      cmax = [...hi];
    for (const i of ids) {
      const t = this.triangles[i];
      for (let a = 0; a < 3; a++) {
        lo[a] = Math.min(lo[a], t.lo[a]);
        hi[a] = Math.max(hi[a], t.hi[a]);
        cmin[a] = Math.min(cmin[a], t.centroid[a]);
        cmax[a] = Math.max(cmax[a], t.centroid[a]);
      }
    }
    const node = { lo, hi, escape: 0, first: 0, count: 0 };
    this.nodes.push(node);
    if (ids.length <= leafSize) {
      node.first = this.order.length;
      node.count = ids.length;
      this.order.push(...ids);
    } else {
      // Binned surface-area heuristic; deterministic median fallback for coincident centroids.
      let best = null;
      const bins = 12;
      const area = (l, h) => {
        const d = h.map((v, a) => Math.max(0, v - l[a]));
        return d[0] * d[1] + d[1] * d[2] + d[2] * d[0];
      };
      for (let axis = 0; axis < 3; axis++) {
        const extent = cmax[axis] - cmin[axis];
        if (extent < 1e-9) continue;
        const bb = Array.from({ length: bins }, () => ({
          n: 0,
          lo: [Infinity, Infinity, Infinity],
          hi: [-Infinity, -Infinity, -Infinity],
        }));
        for (const i of ids) {
          const t = this.triangles[i],
            b =
              bb[
                Math.min(
                  bins - 1,
                  Math.floor(((t.centroid[axis] - cmin[axis]) / extent) * bins),
                )
              ];
          b.n++;
          for (let a = 0; a < 3; a++) {
            b.lo[a] = Math.min(b.lo[a], t.lo[a]);
            b.hi[a] = Math.max(b.hi[a], t.hi[a]);
          }
        }
        for (let cut = 1; cut < bins; cut++) {
          let ln = 0,
            rn = 0,
            ll = [Infinity, Infinity, Infinity],
            lh = [-Infinity, -Infinity, -Infinity],
            rl = [...ll],
            rh = [...lh];
          for (let b = 0; b < bins; b++) {
            const q = bb[b];
            if (!q.n) continue;
            const l = b < cut ? ll : rl,
              h = b < cut ? lh : rh;
            if (b < cut) ln += q.n;
            else rn += q.n;
            for (let a = 0; a < 3; a++) {
              l[a] = Math.min(l[a], q.lo[a]);
              h[a] = Math.max(h[a], q.hi[a]);
            }
          }
          if (!ln || !rn) continue;
          const cost = ln * area(ll, lh) + rn * area(rl, rh);
          if (!best || cost < best.cost)
            best = { axis, split: cmin[axis] + (extent * cut) / bins, cost };
        }
      }
      let left = [],
        right = [];
      if (best)
        for (const i of ids)
          (this.triangles[i].centroid[best.axis] < best.split
            ? left
            : right
          ).push(i);
      if (!left.length || !right.length) {
        let axis = 0;
        for (let a = 1; a < 3; a++)
          if (cmax[a] - cmin[a] > cmax[axis] - cmin[axis]) axis = a;
        ids.sort(
          (i, j) =>
            this.triangles[i].centroid[axis] -
              this.triangles[j].centroid[axis] || i - j,
        );
        left = ids.slice(0, ids.length >> 1);
        right = ids.slice(ids.length >> 1);
      }
      this.build(left, leafSize, depth + 1);
      this.build(right, leafSize, depth + 1);
    }
    node.escape = this.nodes.length;
    return index;
  }
  intersect(origin, direction, far = Infinity) {
    let i = 0,
      steps = 0,
      best = null;
    while (i < this.nodes.length) {
      steps++;
      const n = this.nodes[i];
      let near = 0,
        exit = far;
      for (let a = 0; a < 3; a++) {
        if (Math.abs(direction[a]) < 1e-12) {
          if (origin[a] < n.lo[a] || origin[a] > n.hi[a]) exit = -1;
          continue;
        }
        const x = (n.lo[a] - origin[a]) / direction[a],
          y = (n.hi[a] - origin[a]) / direction[a];
        near = Math.max(near, Math.min(x, y));
        exit = Math.min(exit, Math.max(x, y));
      }
      if (exit < near) {
        i = n.escape;
        continue;
      }
      if (!n.count) {
        i++;
        continue;
      }
      for (let j = 0; j < n.count; j++) {
        const id = this.order[n.first + j],
          t = this.triangles[id];
        const e1 = new THREE.Vector3(...t.e1),
          e2 = new THREE.Vector3(...t.e2),
          dir = new THREE.Vector3(...direction);
        const p = dir.clone().cross(e2),
          det = e1.dot(p);
        if (Math.abs(det) < 1e-10) continue;
        const s = new THREE.Vector3(...origin).sub(new THREE.Vector3(...t.v0)),
          inv = 1 / det,
          u = s.dot(p) * inv;
        if (u < 0 || u > 1) continue;
        const q = s.clone().cross(e1),
          v = dir.dot(q) * inv;
        if (v < 0 || u + v > 1) continue;
        const distance = e2.dot(q) * inv;
        if (distance > 1e-4 && distance < far) {
          far = distance;
          best = { distance, u, v, triangle: id };
        }
      }
      i = n.escape;
    }
    return { hit: best, steps };
  }
}
function meshTriangles(mesh, rootInverse = new THREE.Matrix4()) {
  mesh.updateWorldMatrix(true, false);
  const transform = new THREE.Matrix4().multiplyMatrices(
    rootInverse,
    mesh.matrixWorld,
  );
  const normalTransform = new THREE.Matrix3().getNormalMatrix(transform);
  const g = mesh.geometry,
    p = g.attributes.position,
    n = g.attributes.normal,
    ix = g.index;
  const triangles = [];
  const count = ix ? ix.count : p.count;
  const albedo = mesh.material.uniforms?.uAlbedo?.value?.toArray() || [
    0.4, 0.4, 0.4,
  ];
  const kind = mesh.material.uniforms?.uKind?.value ?? 1;
  for (let k = 0; k < count; k += 3) {
    const ids = [0, 1, 2].map((j) => (ix ? ix.getX(k + j) : k + j));
    const vs = ids.map((i) =>
      new THREE.Vector3().fromBufferAttribute(p, i).applyMatrix4(transform),
    );
    const e1 = vs[1].clone().sub(vs[0]),
      e2 = vs[2].clone().sub(vs[0]);
    const geom = e1.clone().cross(e2);
    if (geom.lengthSq() < 1e-16) continue;
    const normals = ids.map((i) =>
      n
        ? new THREE.Vector3()
            .fromBufferAttribute(n, i)
            .applyMatrix3(normalTransform)
            .normalize()
        : geom.clone().normalize(),
    );
    const va = vs.map((v) => v.toArray());
    triangles.push({
      v0: va[0],
      e1: e1.toArray(),
      e2: e2.toArray(),
      normals: normals.map((v) => v.toArray()),
      albedo,
      kind,
      lo: [0, 1, 2].map((a) => Math.min(...va.map((v) => v[a])) - 1e-5),
      hi: [0, 1, 2].map((a) => Math.max(...va.map((v) => v[a])) + 1e-5),
      centroid: [0, 1, 2].map((a) => (va[0][a] + va[1][a] + va[2][a]) / 3),
    });
  }
  return triangles;
}
class RayScene {
  constructor(world) {
    world.scene.updateMatrixWorld(true);
    this.rockPlacementKey = world.rockPlacementKey;
    this.instances = [
      { root: null, meshes: world.rocks },
      ...[world.boat, ...world.buoyModels].map((root) => {
        const meshes = [];
        root.traverse((o) => {
          if (o.isMesh) meshes.push(o);
        });
        return { root, meshes };
      }),
    ];
    const nodes = [],
      triangles = [];
    this.roots = [];
    this.bvhs = [];
    for (const instance of this.instances) {
      const inverse = instance.root
        ? instance.root.matrixWorld.clone().invert()
        : new THREE.Matrix4();
      const bvh = new TriangleBVH(
        instance.meshes.flatMap((m) => meshTriangles(m, inverse)),
      );
      this.bvhs.push(bvh);
      const nodeBase = nodes.length / 8,
        triBase = triangles.length / 28;
      this.roots.push(nodeBase);
      for (const n of bvh.nodes)
        nodes.push(
          ...n.lo,
          nodeBase + n.escape,
          ...n.hi,
          n.count ? (triBase + n.first) * 16 + n.count : 0,
        );
      for (const id of bvh.order) {
        const t = bvh.triangles[id];
        triangles.push(
          ...t.v0,
          t.kind,
          ...t.e1,
          0,
          ...t.e2,
          0,
          ...t.normals[0],
          0,
          ...t.normals[1],
          0,
          ...t.normals[2],
          0,
          ...t.albedo,
          0,
        );
      }
    }
    const pack = (values) => {
      const w = 1024,
        h = Math.max(1, Math.ceil(values.length / (w * 4))),
        data = new Float32Array(w * h * 4);
      data.set(values);
      return dataTexture(data, w, h);
    };
    this.nodeTexture = pack(nodes);
    this.triangleTexture = pack(triangles);
    this.uniforms = {
      uRayNodes: U(this.nodeTexture),
      uRayTriangles: U(this.triangleTexture),
      uRayRoots: U(new Int32Array(this.roots)),
      uRayActive: U(new Int32Array(5)),
      uRayInv: U(this.instances.map(() => new THREE.Matrix4())),
      uRayMatrix: U(this.instances.map(() => new THREE.Matrix4())),
    };
    this.stats = {
      triangles: triangles.length / 28,
      nodes: nodes.length / 8,
      maximumDepth: Math.max(...this.bvhs.map((b) => b.maxDepth)),
      textureBytes:
        this.nodeTexture.image.data.byteLength +
        this.triangleTexture.image.data.byteLength,
    };
  }
  syncStaticWorld(world) {
    if (this.rockPlacementKey === world.rockPlacementKey) return;
    // Configuration-time rebuild only. Uniform objects retain their identity:
    // all existing render passes must immediately see the new triangle tables.
    const fresh = new RayScene(world);
    for (const [name, uniform] of Object.entries(this.uniforms)) {
      uniform.value = fresh.uniforms[name].value;
    }
    this.nodeTexture.dispose();
    this.triangleTexture.dispose();
    for (const name of [
      "instances",
      "roots",
      "bvhs",
      "nodeTexture",
      "triangleTexture",
      "stats",
      "rockPlacementKey",
    ])
      this[name] = fresh[name];
  }
  update(preset) {
    const u = this.uniforms;
    for (let i = 0; i < 5; i++) {
      u.uRayActive.value[i] =
        i === 0
          ? +!!preset.terrain
          : i === 1
            ? +!!preset.boat
            : +!!preset.buoys;
      const root = this.instances[i].root;
      if (root) {
        root.updateMatrixWorld(true);
        u.uRayMatrix.value[i].copy(root.matrixWorld);
        u.uRayInv.value[i].copy(root.matrixWorld).invert();
      }
    }
  }
}
const raySceneGLSL = `
uniform highp sampler2D uRayNodes,uRayTriangles;
uniform int uRayRoots[5],uRayActive[5];
uniform mat4 uRayInv[5],uRayMatrix[5];
vec4 nodeTex(int i){return texelFetch(uRayNodes,ivec2(i%1024,i/1024),0);}
vec4 triTex(int i){return texelFetch(uRayTriangles,ivec2(i%1024,i/1024),0);}
bool boxHit(vec3 o,vec3 d,vec3 lo,vec3 hi,float best){
 vec3 ad=max(abs(d),vec3(1e-9)),di=mix(-1./ad,1./ad,greaterThanEqual(d,vec3(0.)));
 vec3 a=(lo-o)*di,b=(hi-o)*di;
 vec3 mn=min(a,b),mx=max(a,b);
 return max(0.,max(mn.x,max(mn.y,mn.z)))<=min(best,min(mx.x,min(mx.y,mx.z)));
}
bool traceTriangles(vec3 origin,vec3 direction,inout float nearest,out vec3 normal,out vec3 albedo,out float kind){
 bool hit=false;
 for(int inst=0;inst<5;inst++){
  if(uRayActive[inst]==0)continue;
  vec3 o=(uRayInv[inst]*vec4(origin,1.)).xyz,d=(uRayInv[inst]*vec4(direction,0.)).xyz;
  int index=uRayRoots[inst],end=int(nodeTex(index*2).w+.5);
  for(int step=0;step<1024;step++){
   if(index>=end)break;
   vec4 lo=nodeTex(index*2),hi=nodeTex(index*2+1);
   if(!boxHit(o,d,lo.xyz,hi.xyz,nearest)){index=int(lo.w+.5);continue;}
   int packed=int(hi.w+.5);if(packed==0){index++;continue;}
   int start=packed/16,count=packed%16;
   for(int j=0;j<6;j++){
    if(j>=count)break;int offset=(start+j)*7;
    vec4 v0=triTex(offset);vec3 e1=triTex(offset+1).xyz,e2=triTex(offset+2).xyz;
    vec3 p=cross(d,e2);float det=dot(e1,p);if(abs(det)<1e-9)continue;
    float inv=1./det;vec3 s=o-v0.xyz;float u=dot(s,p)*inv;if(u<0.||u>1.)continue;
    vec3 q=cross(s,e1);float v=dot(d,q)*inv;if(v<0.||u+v>1.)continue;
    float t=dot(e2,q)*inv;
    if(t>.001&&t<nearest){
     nearest=t;normal=normalize(mat3(transpose(uRayInv[inst]))*(triTex(offset+3).xyz*(1.-u-v)+triTex(offset+4).xyz*u+triTex(offset+5).xyz*v));
     if(dot(normal,direction)>0.)normal=-normal;
     albedo=triTex(offset+6).xyz;kind=v0.w;hit=true;
    }
   }
   index=int(lo.w+.5);
  }
 }
 return hit;
}
// The terrain receiver uses the same analytic height function as its mesh.
// It is not inferred from a screen-depth hit or from an unrelated flat plane.
bool traceTerrain(vec3 origin,vec3 direction,inout float nearest,out vec3 normal){
 if(uRayActive[0]==0)return false;
 float t=0.;float initial=origin.y-bedHeight(origin.xz);if(initial<-.04)return false;
 for(int j=0;j<64;j++){
  vec3 p=origin+direction*t;if(abs(p.x)>169.||abs(p.z)>169.||t>=nearest)return false;
  float h=p.y-bedHeight(p.xz);
  if(h<.006&&t>.008){float eps=.025;vec2 grad=vec2(bedHeight(p.xz+vec2(eps,0.))-bedHeight(p.xz-vec2(eps,0.)),bedHeight(p.xz+vec2(0.,eps))-bedHeight(p.xz-vec2(0.,eps)))/(2.*eps);normal=normalize(vec3(-grad.x,1.,-grad.y));nearest=t;return true;}
  // A conservative directional height-function bound, followed by small steps near a receiver.
  t+=max(.008,h/max(.03,abs(direction.y)+1.15*length(direction.xz)));
 }
 return false;
}
bool rayScene(vec3 origin,vec3 direction,out vec3 pos,out vec3 normal,out vec3 albedo,out float kind,out float distance){
 distance=350.;vec3 triNormal,triAlbedo;float triKind=0.;
 bool hit=traceTriangles(origin,direction,distance,triNormal,triAlbedo,triKind);
 if(hit){normal=triNormal;albedo=triAlbedo;kind=triKind;}
 vec3 groundNormal;
 if(traceTerrain(origin,direction,distance,groundNormal)){normal=groundNormal;albedo=vec3(.59,.53,.38);kind=0.;hit=true;}
 pos=origin+direction*distance;return hit;
}
`;



return {TriangleBVH,meshTriangles,RayScene,raySceneGLSL};
})();
__M["src/light-transport.js"]=(()=>{

/** Flat-interface direct beam transport; RGB extinction in inverse metres.
 * The cosine ratio preserves transmitted power per horizontal interface area.
 * This does not replace caustic focusing or resolve curved-interface visibility.
 */
const directBeamGLSL = `
vec3 directSolarTransfer(vec3 sun,vec3 extinction,float depth,bool submerged,float cloud,out vec3 L){
 sun=normalize(sun);float mu=max(0.,sun.y);L=sun;
 if(mu<=0.)return vec3(0.);
 float visible=clamp(cloud,0.,1.);if(!submerged)return vec3(visible);
 float eta=1./1.333,cw=sqrt(max(0.,1.-eta*eta*(1.-mu*mu)));
 L=vec3(sun.x*eta,cw,sun.z*eta);
 float rs=(mu-1.333*cw)/(mu+1.333*cw),rp=(1.333*mu-cw)/(1.333*mu+cw),F=.5*(rs*rs+rp*rp);
 float beamPower=(1.-F)*mu/max(.00001,cw);
 return vec3(visible*beamPower)*exp(-max(extinction,vec3(0.))*max(0.,depth)/max(.00001,cw));
}
`;
function directSolarTransferJS(
  sun,
  extinction,
  depth,
  submerged,
  cloud = 1,
) {
  if (
    !sun.every(Number.isFinite) ||
    !extinction.every((v) => Number.isFinite(v) && v >= 0) ||
    !Number.isFinite(depth) ||
    !Number.isFinite(cloud)
  )
    throw new RangeError("Invalid beam inputs");
  const n = Math.hypot(...sun);
  if (n === 0) throw new RangeError("Zero light direction");
  const s = sun.map((v) => v / n),
    mu = Math.max(0, s[1]),
    visible = Math.max(0, Math.min(1, cloud));
  if (mu <= 0) return { direction: s, transfer: [0, 0, 0] };
  if (!submerged)
    return { direction: s, transfer: [visible, visible, visible] };
  const eta = 1 / 1.333,
    cw = Math.sqrt(1 - eta * eta * (1 - mu * mu));
  const rs = (mu - 1.333 * cw) / (mu + 1.333 * cw),
    rp = (1.333 * mu - cw) / (1.333 * mu + cw);
  const power = ((1 - (rs * rs + rp * rp) / 2) * mu) / cw;
  return {
    direction: [s[0] * eta, cw, s[2] * eta],
    transfer: extinction.map(
      (x) => visible * power * Math.exp((-x * Math.max(0, depth)) / cw),
    ),
  };
}



return {directBeamGLSL,directSolarTransferJS};
})();
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
__M["src/interaction-kernel.js"]=(()=>{

/** Discrete, wet-cell-aware source normalization. Normalizing the actual stencil
 * removes the net water-volume injection of the old truncated Mexican hat. */
function normalizedSource(x,z,radius,n,size,bed,defaultDepth=1.1) {
  const dx=size/n,r=Math.max(radius,dx*.65),items=[];
  const clamp=(v)=>Math.max(0,Math.min(n-1,v));
  const loX=clamp(Math.ceil((x-3*r+size/2)/dx-.5)),hiX=clamp(Math.floor((x+3*r+size/2)/dx-.5));
  const loZ=clamp(Math.ceil((z-3*r+size/2)/dx-.5)),hiZ=clamp(Math.floor((z+3*r+size/2)/dx-.5));
  let gSum=0,lapSum=0,mx=0,mz=0;
  for(let j=loZ;j<=hiZ;j++)for(let i=loX;i<=hiX;i++) {
    const id=(j*n+i)*4,H=bed?bed[id]:defaultDepth;if(H<.02)continue;
    const px=((i+.5)*dx-size/2-x)/r,pz=((j+.5)*dx-size/2-z)/r,r2=px*px+pz*pz;
    if(r2>9)continue;const g=Math.exp(-.5*r2),l=(1-.5*r2)*g;
    gSum+=g;lapSum+=l;mx+=g*(bed?bed[id+1]:H);mz+=g*(bed?bed[id+2]:H);
    items.push({i,j,g,l,depth:H});
  }
  const mean=gSum?lapSum/gSum:0;
  return {radius:r,mean,momentumX:mx>0?1/(1025*dx*dx*mx):0,momentumZ:mz>0?1/(1025*dx*dx*mz):0,
    items:items.map(p=>({...p,heightWeight:p.l-mean*p.g})),accepted:gSum>0};
}



return {normalizedSource};
})();
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
__M["src/fft.js"]=(()=>{

/** In-place radix-2 inverse FFT. The only normalization is 1/N in each 1D pass. */
class FFT {
  constructor(n) {
    if (n < 2 || n & (n - 1))
      throw new RangeError("FFT size must be a power of two");
    this.n = n;
    this.reverse = new Uint32Array(n);
    this.cos = new Float64Array(n / 2);
    this.sin = new Float64Array(n / 2);
    let bits = Math.log2(n);
    for (let i = 0; i < n; i++) {
      let x = i,
        r = 0;
      for (let j = 0; j < bits; j++) {
        r = (r << 1) | (x & 1);
        x >>>= 1;
      }
      this.reverse[i] = r;
    }
    for (let i = 0; i < n / 2; i++) {
      this.cos[i] = Math.cos((2 * Math.PI * i) / n);
      this.sin[i] = Math.sin((2 * Math.PI * i) / n);
    }
  }
  transform(re, im, offset = 0, stride = 1, inverse = true) {
    const n = this.n,
      rev = this.reverse;
    for (let i = 0; i < n; i++) {
      const j = rev[i];
      if (j > i) {
        const a = offset + i * stride,
          b = offset + j * stride;
        let x = re[a];
        re[a] = re[b];
        re[b] = x;
        x = im[a];
        im[a] = im[b];
        im[b] = x;
      }
    }
    for (let size = 2; size <= n; size *= 2) {
      const half = size / 2,
        step = n / size;
      for (let base = 0; base < n; base += size)
        for (let j = 0; j < half; j++) {
          const tw = j * step,
            wr = this.cos[tw],
            wi = this.sin[tw] * (inverse ? 1 : -1),
            a = offset + (base + j) * stride,
            b = a + half * stride,
            tr = wr * re[b] - wi * im[b],
            ti = wr * im[b] + wi * re[b];
          re[b] = re[a] - tr;
          im[b] = im[a] - ti;
          re[a] += tr;
          im[a] += ti;
        }
    }
    if (inverse)
      for (let j = 0; j < n; j++) {
        const i = offset + j * stride;
        re[i] /= n;
        im[i] /= n;
      }
  }
  transform2D(re, im, inverse = true) {
    const n = this.n;
    if (re.length !== n * n || im.length !== n * n)
      throw new RangeError("Wrong FFT buffer dimensions");
    for (let y = 0; y < n; y++) this.transform(re, im, y * n, 1, inverse);
    for (let x = 0; x < n; x++) this.transform(re, im, x, n, inverse);
  }
}



return {FFT};
})();
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
__M["src/gpu-ocean.js"]=(()=>{

const { THREE, Pass, target, dataTexture, bilinearGLSL, uniform:U }=__M["src/gpu.js"];
const { Spectrum, BANDS }=__M["src/spectrum.js"];
const header = `precision highp float;precision highp int;in vec2 vUv;out vec4 fragColor;`;
const evolveFragment =
  header +
  `
uniform highp sampler2D uInitial;uniform int uN;uniform float uTime,uChop;
vec2 timesI(vec2 a,float b){return vec2(-a.y,a.x)*b;}
void main(){ivec2 p=ivec2(gl_FragCoord.xy);int band=p.x/uN,field=p.y/uN;ivec2 c=ivec2(p.x%uN,p.y%uN),mirror=(ivec2(uN)-c)%uN;
 vec4 a=texelFetch(uInitial,ivec2(band*uN+c.x,c.y),0),b=texelFetch(uInitial,ivec2(band*uN+mirror.x,mirror.y),0);
 float angle=a.z*uTime,co=cos(angle),si=sin(angle);vec2 h=vec2((a.x+b.x)*co+(a.y+b.y)*si,(a.y-b.y)*co+(b.x-a.x)*si);
 vec2 ht=a.z*vec2(-(a.x+b.x)*si+(a.y+b.y)*co,-(a.y-b.y)*si+(b.x-a.x)*co);
 float len=band==0?768.:(band==1?96.:12.);vec2 k=vec2(c.x<=uN/2?c.x:c.x-uN,c.y<=uN/2?c.y:c.y-uN)*6.28318530718/len;
 float cp=uChop/max(length(k),1e-8);vec2 f0,f1;
 // Pair two Hermitian spectra into one complex inverse transform.
 // Re(IFFT(F+iG))=f; Im(IFFT(F+iG))=g. Four real fields per RGBA texel.
 if(field==0){f0=h+timesI(timesI(h,k.x*cp),1.);f1=timesI(h,k.y*cp)+timesI(timesI(h,k.x),1.);}
 else if(field==1){f0=timesI(h,k.y)+timesI(-k.x*k.x*cp*h,1.);f1=-k.x*k.y*cp*h+timesI(-k.y*k.y*cp*h,1.);}
 else{f0=timesI(ht,k.x*cp)+timesI(ht,1.);f1=timesI(ht,k.y*cp);}
 fragColor=vec4(f0,f1)*float(uN*uN);
}`;
const fftFragment =
  header +
  `
uniform highp sampler2D uInput;uniform int uN,uStage,uAxis;
int reverseBitsN(int a){int r=0;for(int j=1;j<1024;j*=2){if(j>=uN)break;r=r*2+(a&1);a>>=1;}return r;}
vec2 cmul(vec2 a,vec2 b){return vec2(a.x*b.x-a.y*b.y,a.x*b.y+a.y*b.x);}
void main(){ivec2 p=ivec2(gl_FragCoord.xy),tile=(p/uN)*uN,c=p%uN;
 int index=uAxis==0?c.x:c.y,span=1<<(uStage+1),halfSpan=span/2,j=index%span;
 int ia=index-j+j%halfSpan,ib=ia+halfSpan;if(uStage==0){ia=reverseBitsN(ia);ib=reverseBitsN(ib);}
 ivec2 pa=tile+c,pb=pa;if(uAxis==0){pa.x=tile.x+ia;pb.x=tile.x+ib;}else{pa.y=tile.y+ia;pb.y=tile.y+ib;}
 vec4 a=texelFetch(uInput,pa,0),b=texelFetch(uInput,pb,0);float angle=6.28318530718*float(j%halfSpan)/float(span);vec2 w=vec2(cos(angle),sin(angle));
 vec4 rotated=vec4(cmul(b.xy,w),cmul(b.zw,w));fragColor=a+(j<halfSpan?rotated:-rotated);if(span==uN)fragColor/=float(uN);
}`;
const packFragment = `precision highp float;precision highp int;in vec2 vUv;
layout(location=0) out vec4 disp;layout(location=1) out vec4 dx;layout(location=2) out vec4 dz;
uniform highp sampler2D uInput;uniform int uN,uBand;
vec4 readField(ivec2 p,int field){return texelFetch(uInput,ivec2(uBand*uN+p.x,field*uN+p.y),0);}
void main(){ivec2 p=ivec2(gl_FragCoord.xy);vec4 a=readField(p,0),b=readField(p,1),c=readField(p,2);disp=vec4(a.y,a.x,a.z,c.y);dx=vec4(b.y,a.w,b.z,c.x);dz=vec4(b.z,b.x,b.w,c.z);}`;
const waveDeclarations = `
${bilinearGLSL}
precision highp sampler2DArray;
uniform highp sampler2DArray uDisplacement,uDerivativeX,uDerivativeZ;
uniform float uN,uWaveScale;
void waveAt(vec2 q,vec3 lod,out vec3 d,out vec3 tx,out vec3 tz,out vec3 velocity){
 vec2 off=vec2(.5/uN);vec4 a=textureLod(uDisplacement,vec3(q/768.+off,float(0)),lod[0]),b=textureLod(uDisplacement,vec3(q/96.+off,float(1)),lod[1]),c=textureLod(uDisplacement,vec3(q/12.+off,float(2)),lod[2]);
 vec4 x0=textureLod(uDerivativeX,vec3(q/768.+off,float(0)),lod[0]),x1=textureLod(uDerivativeX,vec3(q/96.+off,float(1)),lod[1]),x2=textureLod(uDerivativeX,vec3(q/12.+off,float(2)),lod[2]);
 vec4 z0=textureLod(uDerivativeZ,vec3(q/768.+off,float(0)),lod[0]),z1=textureLod(uDerivativeZ,vec3(q/96.+off,float(1)),lod[1]),z2=textureLod(uDerivativeZ,vec3(q/12.+off,float(2)),lod[2]);
 d=(a.xyz+b.xyz+c.xyz)*uWaveScale;tx=vec3(1.,0.,0.)+(x0.xyz+x1.xyz+x2.xyz)*uWaveScale;tz=vec3(0.,0.,1.)+(z0.xyz+z1.xyz+z2.xyz)*uWaveScale;
 velocity=vec3(x0.w+x1.w+x2.w,a.w+b.w+c.w,z0.w+z1.w+z2.w)*uWaveScale;
}
void wave(vec2 q,out vec3 d,out vec3 tx,out vec3 tz,out vec3 velocity){waveAt(q,vec3(0.),d,tx,tz,velocity);}
vec3 displace(vec2 q){vec2 o=vec2(.5/uN);return (textureLod(uDisplacement,vec3(q/768.+o,float(0)),0.).xyz+textureLod(uDisplacement,vec3(q/96.+o,float(1)),0.).xyz+textureLod(uDisplacement,vec3(q/12.+o,float(2)),0.).xyz)*uWaveScale;}
`;
const queryFragment =
  header +
  waveDeclarations +
  `
uniform highp sampler2D uPositions,uInteraction;uniform float uPatchSize;
void main(){int row=int(gl_FragCoord.y)/2,id=int(gl_FragCoord.x);vec2 point=texelFetch(uPositions,ivec2(id,row),0).xz,q=point;
 for(int j=0;j<5;j++)q=point-displace(q).xz;
 vec3 d,tx,tz,vel;wave(q,d,tx,tz,vel);float h=d.y;vec2 uv=point/uPatchSize+.5;
 if(all(greaterThan(uv,vec2(.01)))&&all(lessThan(uv,vec2(.99)))){vec4 localFlow=sampleBilinear(uInteraction,uv);h+=localFlow.x;vel.xz+=localFlow.yz;float eps=1./256.,dx=uPatchSize*eps;vec2 slope=vec2(sampleBilinear(uInteraction,uv+vec2(eps,0.)).x-sampleBilinear(uInteraction,uv-vec2(eps,0.)).x,sampleBilinear(uInteraction,uv+vec2(0.,eps)).x-sampleBilinear(uInteraction,uv-vec2(0.,eps)).x)/(2.*dx);tx.y+=dot(slope,tx.xz);tz.y+=dot(slope,tz.xz);}
 vec3 normal=normalize(cross(tz,tx));float jac=tx.x*tz.z-tx.z*tz.x;
 fragColor=(int(gl_FragCoord.y)%2)==0?vec4(h,normal.x,normal.z,jac):vec4(vel,normal.y);
}`;
/** GPU-resident atlas IFFT. One evolution + 2 log2(N) butterfly + 3 MRT pack passes.
 * No dynamic spectrum or derivative texture uploads during ordinary wave updates.
 */
class GPUOcean {
  constructor(renderer, n = 128) {
    if (!Number.isInteger(n) || n < 16 || n > 512 || n & (n - 1))
      throw new RangeError(
        "FFT resolution must be a power of two from 16 to 512",
      );
    this.renderer = renderer;
    this.n = n;
    this.steps = Math.log2(n);
    this.time = 0;
    this.uniforms = { uN: U(n), uWaveScale: U(1) };
    this.a = target(3 * n, 3 * n);
    this.b = target(3 * n, 3 * n);
    // Three array textures, with one independently wrapping layer per wave band.
    // MRT packing writes displacement + two derivative/velocity textures in one draw.
    // This reduces fragment texture bindings from nine to three without tile seams.
    this.fieldArray = new THREE.WebGLArrayRenderTarget(n, n, 3, {
      count: 3,
      type: renderer.extensions.has("OES_texture_float_linear") ? THREE.FloatType : THREE.HalfFloatType,
      format: THREE.RGBAFormat,
      minFilter: THREE.LinearMipmapLinearFilter,
      magFilter: THREE.LinearFilter,
      depthBuffer: false,
      stencilBuffer: false,
      generateMipmaps: true,
    });
    for (let i = 1; i < 3; i++)
      this.fieldArray.textures[i] = this.fieldArray.texture.clone();
    for (let i = 0; i < 3; i++) {
      const t = this.fieldArray.textures[i];
      t.isRenderTargetTexture = true;
      t.renderTarget = this.fieldArray;
      t.colorSpace = THREE.NoColorSpace;
      t.generateMipmaps = true;
      t.wrapS = t.wrapT = THREE.RepeatWrapping;
      this.uniforms[["uDisplacement", "uDerivativeX", "uDerivativeZ"][i]] =
        U(t);
    }
    this.fields = [this.fieldArray];
    this.evolve = new Pass(evolveFragment, {
      uInitial: U(null),
      uN: U(n),
      uTime: U(0),
      uChop: U(1),
    });
    this.fft = new Pass(fftFragment, {
      uInput: U(null),
      uN: U(n),
      uStage: U(0),
      uAxis: U(0),
    });
    this.pack = new Pass(packFragment, {
      uInput: U(null),
      uN: U(n),
      uBand: U(0),
    });
    this.queryPositions = new Float32Array(128 * 4);
    this.queryTexture = dataTexture(this.queryPositions, 128, 1);
    this.queryTarget = target(128, 2);
    this.queryPass = new Pass(queryFragment, {
      ...this.uniforms,
      uPositions: U(this.queryTexture),
      uInteraction: U(null),
      uPatchSize: U(128),
    });
    this.queryBuffer = new Float32Array(128 * 2 * 4);
  }
  reset(preset, seed = 91317) {
    this.preset = preset;
    this.spectrum = new Spectrum(this.n, preset, seed);
    const n = this.n,
      data = new Float32Array(3 * n * n * 4);
    for (let b = 0; b < 3; b++)
      for (let y = 0; y < n; y++)
        data.set(
          this.spectrum.bands[b].h0.subarray(y * n * 4, (y + 1) * n * 4),
          (y * 3 * n + b * n) * 4,
        );
    if (this.initial) this.initial.dispose();
    this.initial = dataTexture(data, 3 * n, n);
    this.evolve.uniforms.uInitial.value = this.initial;
    this.evolve.uniforms.uChop.value = preset.chop;
    this.step(0);
  }
  step(time) {
    this.time = time;
    this.evolve.uniforms.uTime.value = time;
    this.evolve.run(this.renderer, this.a);
    let src = this.a,
      dst = this.b;
    for (let axis = 0; axis < 2; axis++)
      for (let stage = 0; stage < this.steps; stage++) {
        this.fft.uniforms.uInput.value = src.texture;
        this.fft.uniforms.uStage.value = stage;
        this.fft.uniforms.uAxis.value = axis;
        this.fft.run(this.renderer, dst);
        [src, dst] = [dst, src];
      }
    this.pack.uniforms.uInput.value = src.texture;
    for (let band = 0; band < 3; band++) {
      this.pack.uniforms.uBand.value = band;
      for (const t of this.fieldArray.textures) t.generateMipmaps = band === 2;
      this.pack.run(this.renderer, this.fieldArray, band);
    }
    this.renderer.setRenderTarget(null);
  }
  query(points, interaction, patchSize=128){
    if(points.length>16384)throw new RangeError('Surface query capacity exceeded');
    const large=points.length>128,capacity=large?2**Math.ceil(Math.log2(points.length)):128;
    if(large&&(!this.largeQuery||this.largeQuery.capacity<capacity)){
      this.largeQuery?.texture.dispose();this.largeQuery?.target.dispose();
      const positions=new Float32Array(capacity*4);
      this.largeQuery={capacity,positions,texture:dataTexture(positions,128,capacity/128),target:target(128,2*capacity/128),buffer:new Float32Array(capacity*8)};
    }
    const q=large?this.largeQuery:{capacity:128,positions:this.queryPositions,texture:this.queryTexture,target:this.queryTarget,buffer:this.queryBuffer};
    for(let i=0;i<points.length;i++){q.positions[i*4]=points[i][0];q.positions[i*4+2]=points[i][1];}
    q.texture.needsUpdate=true;
    this.queryPass.uniforms.uPositions.value=q.texture;this.queryPass.uniforms.uInteraction.value=interaction;this.queryPass.uniforms.uPatchSize.value=patchSize;
    this.queryPass.run(this.renderer,q.target);
    this.renderer.readRenderTargetPixels(q.target,0,0,128,2*q.capacity/128,q.buffer);this.renderer.setRenderTarget(null);
    return points.map((p,i)=>{const a=(Math.floor(i/128)*256+i%128)*4,b=a+512;return {height:q.buffer[a],normal:[q.buffer[a+1],q.buffer[b+3],q.buffer[a+2]],jacobian:q.buffer[a+3],velocity:Array.from(q.buffer.subarray(b,b+3))};});
  }

  verify(time = 13.27) {
    this.step(time);
    const reports = [];
    for (let band = 0; band < 3; band++) {
      const ref = this.spectrum.reference(time, band),
        n = this.n,
        buffer = new Float32Array(n * n * 4);
      this.renderer.setRenderTarget(this.fieldArray, band);
      this.renderer.readRenderTargetPixels(
        this.fieldArray,
        0,
        0,
        n,
        n,
        buffer,
        0,
      );
      let max = 0,
        ss = 0;
      for (let i = 0; i < n * n; i++) {
        const e = buffer[i * 4 + 1] - ref.h.r[i];
        max = Math.max(max, Math.abs(e));
        ss += e * e;
      }
      const fieldErrors = {};
      for (let attachment = 0; attachment < 3; attachment++) {
        this.renderer.setRenderTarget(this.fieldArray, band);
        this.renderer.readRenderTargetPixels(
          this.fieldArray,
          0,
          0,
          n,
          n,
          buffer,
          0,
          attachment,
        );
        const names = [
          ["x", "h", "z", "vy"],
          ["xx", "hx", "xz", "vx"],
          ["xz", "hz", "zz", "vz"],
        ][attachment];
        for (let channel = 0; channel < 4; channel++) {
          let m = 0,
            sum = 0;
          for (let i = 0; i < n * n; i++) {
            const e = buffer[i * 4 + channel] - ref[names[channel]].r[i];
            m = Math.max(m, Math.abs(e));
            sum += e * e;
          }
          fieldErrors[names[channel]] = {
            max: m,
            rms: Math.sqrt(sum / (n * n)),
          };
        }
      }
      reports.push({
        band,
        maxHeightError: max,
        rmsHeightError: Math.sqrt(ss / (n * n)),
        resolution: n,
        fieldErrors,
      });
    }
    return reports;
  }
  dispose() {
    for (const r of [this.a, this.b, this.queryTarget, ...this.fields])
      r.dispose();
    for (const p of [this.evolve, this.fft, this.pack, this.queryPass])
      p.dispose();
    this.initial?.dispose();
    this.queryTexture.dispose();
  }
}



return {waveDeclarations,GPUOcean};
})();
__M["src/sim-fields.js"]=(()=>{

const { THREE, Pass, target, uniform:U }=__M["src/gpu.js"];
const { normalizedSource }=__M["src/interaction-kernel.js"];
const { dataTexture, bilinearGLSL }=__M["src/gpu.js"];
const { waveDeclarations }=__M["src/gpu-ocean.js"];
/** Finite-volume linear free-surface response, in a fixed world-space region.
 * h,u,v live on a staggered grid. This is not a volumetric Navier-Stokes solver.
 * The sponge deliberately removes outgoing energy; it never follows the camera.
 */
class InteractionField {
  constructor(renderer, n = 256, size = 128, depth = 1.1) {
    this.renderer = renderer;
    this.n = n;
    this.size = size;
    this.depth = depth;
    this.dx = size / n;
    this.count = 0;
    this.appliedImpulse = [0, 0];
    this.a = target(n, n);
    this.b = target(n, n);
    this.sources = target(n, n, {type:renderer.extensions.has("EXT_float_blend") ? THREE.FloatType : THREE.HalfFloatType});
    this.bedData = new Float32Array(n*n*4);
    for(let i=0;i<this.bedData.length;i+=4)this.bedData.set([depth,depth,depth,-depth],i);
    this.bedTexture=dataTexture(this.bedData,n,n);
    this.maxDepth=depth;
    const h=`precision highp float;precision highp int;${bilinearGLSL}
in vec2 vUv;out vec4 fragColor;
    uniform highp sampler2D uState,uSources,uBed;uniform float uDt,uDx,uDepth,uN,uSourceScale;uniform int uStage;
    vec4 get(ivec2 p){return texelFetch(uState,clamp(p,ivec2(0),ivec2(int(uN)-1)),0);}
    vec4 bed(ivec2 p){return texelFetch(uBed,clamp(p,ivec2(0),ivec2(int(uN)-1)),0);}`;
    this.pass=new Pass(h+`
    void main(){
      ivec2 p=ivec2(gl_FragCoord.xy);vec4 q=get(p),b=bed(p),s=texelFetch(uSources,p,0)*uSourceScale;
      if(b.x<.02){fragColor=vec4(0.);return;}
      float edge=min(min(vUv.x,1.-vUv.x),min(vUv.y,1.-vUv.y));
      float damping=exp(-uDt*(.018+10.*pow(max(0.,1.-edge/.12),2.)));
      if(uStage==0){
        q.y=q.y*damping-9.81*uDt/uDx*(get(p+ivec2(1,0)).x-q.x)+s.y;
        q.z=q.z*damping-9.81*uDt/uDx*(get(p+ivec2(0,1)).x-q.x)+s.z;
        if(b.y<.02||p.x==int(uN)-1)q.y=0.;if(b.z<.02||p.y==int(uN)-1)q.z=0.;
      }else{
        float fx=q.y*b.y,fl=p.x>0?get(p-ivec2(1,0)).y*bed(p-ivec2(1,0)).y:0.;
        float fz=q.z*b.z,fb=p.y>0?get(p-ivec2(0,1)).z*bed(p-ivec2(0,1)).z:0.;
        q.x=(q.x-uDt/uDx*(fx-fl+fz-fb))*damping+s.x;
        vec2 flow=vec2(q.y+get(p-ivec2(1,0)).y,q.z+get(p-ivec2(0,1)).z)*.5;
        vec2 uv=clamp(vUv-flow*uDt/(uDx*uN),vec2(0.),vec2(1.));
        q.w=clamp(sampleBilinear(uState,uv).w*exp(-uDt/5.5)+s.w,0.,1.);
      }
      fragColor=q;
    }`,{uState:U(this.a.texture),uSources:U(this.sources.texture),uBed:U(this.bedTexture),uDt:U(1/60),uDx:U(this.dx),uDepth:U(depth),uN:U(n),uStage:U(0),uSourceScale:U(1)});
    this.events = [];
    this.maxEvents = 1024;
    this.pos = new Float32Array(this.maxEvents * 3);
    this.data = new Float32Array(this.maxEvents * 4);
    this.norms = new Float32Array(this.maxEvents * 3);
    // Instanced quads avoid implementation-specific gl_PointSize clipping of
    // larger impulses and keep the exact discrete source stencil intact.
    this.geometry = new THREE.InstancedBufferGeometry();
    this.geometry.setAttribute("position",new THREE.Float32BufferAttribute([-1,-1,0,1,-1,0,1,1,0,-1,1,0],3));
    this.geometry.setIndex([0,1,2,0,2,3]);
    this.geometry.setAttribute("aSource",new THREE.InstancedBufferAttribute(this.pos,3).setUsage(THREE.DynamicDrawUsage));
    this.geometry.setAttribute(
      "aData",
      new THREE.InstancedBufferAttribute(this.data, 4).setUsage(THREE.DynamicDrawUsage),
    );
    this.geometry.setAttribute("aNorm",new THREE.InstancedBufferAttribute(this.norms,3).setUsage(THREE.DynamicDrawUsage));
    this.geometry.instanceCount=0;
    this.material = new THREE.RawShaderMaterial({
      glslVersion: THREE.GLSL3,
      uniforms: { uSize: U(size), uN: U(n), uBed: U(this.bedTexture) },
      vertexShader:`precision highp float;in vec3 position,aSource;in vec4 aData;in vec3 aNorm;uniform float uSize,uN;out vec4 vData;out vec3 vNorm;out vec3 vSource;
      void main(){vec2 center=aSource.xz/uSize*2.;float extent=(aSource.y*3.+uSize/uN)*2./uSize;gl_Position=vec4(center+position.xy*extent,0.,1.);vData=aData;vNorm=aNorm;vSource=aSource;}`,
      fragmentShader:`precision highp float;in vec4 vData;in vec3 vNorm,vSource;out vec4 fragColor;uniform float uSize,uN;uniform highp sampler2D uBed;
      void main(){vec2 point=(gl_FragCoord.xy/uN-.5)*uSize;vec2 p=(point-vSource.xz)/vSource.y;float r2=dot(p,p);if(r2>9.||texelFetch(uBed,ivec2(gl_FragCoord.xy),0).x<.02)discard;float e=exp(-r2*.5);
      fragColor=vec4(vData.x*(1.-.5*r2-vNorm.x)*e,vData.y*vNorm.y*e,vData.z*vNorm.z*e,vData.w*e);}`,
      depthTest: false,
      depthWrite: false,
      transparent: true,
      blending: THREE.CustomBlending,
      blendSrc: THREE.OneFactor,
      blendDst: THREE.OneFactor,
      blendEquation: THREE.AddEquation,
      blendSrcAlpha: THREE.OneFactor,
      blendDstAlpha: THREE.OneFactor,
    });
    this.sourceScene = new THREE.Scene();
    const sourceMesh=new THREE.Mesh(this.geometry,this.material);sourceMesh.frustumCulled=false;this.sourceScene.add(sourceMesh);
    this.camera = new THREE.Camera();
    this.reset();
  }
  get texture() {
    return this.a.texture;
  }
  reset() {
    this.events.length = 0;
    this.active = false;
    this.count = 0;
    this.appliedImpulse = [0, 0];
    const r = this.renderer;
    for (const rt of [this.a, this.b, this.sources]) {
      r.setRenderTarget(rt);
      r.setClearColor(0, 0);
      r.clear();
    }
    r.setRenderTarget(null);
  }
  /** Rasterize static solid tops once per preset, then construct face depths.
   * This represents bathymetry/impermeable columns in a depth-averaged solver,
   * not general three-dimensional overhang or wetting/drying physics. */
  configure(world,preset){
    const n=this.n,top=new Float32Array(n*n*4);
    if(preset.terrain){
      const rt=target(n,n,{depth:true});
      const scene=new THREE.Scene(),group=world.terrainGroup.clone(true);scene.add(group);group.visible=true;
      // Calibration geometry does not become a hidden obstruction.
      group.traverse(o=>{if(o.name==='Calibration markers')o.visible=false;});
      const material=new THREE.RawShaderMaterial({glslVersion:THREE.GLSL3,side:THREE.DoubleSide,
        vertexShader:`precision highp float;in vec3 position;uniform mat4 projectionMatrix,modelViewMatrix,modelMatrix;out float vY;void main(){vY=(modelMatrix*vec4(position,1.)).y;gl_Position=projectionMatrix*modelViewMatrix*vec4(position,1.);}`,
        fragmentShader:`precision highp float;in float vY;out vec4 fragColor;void main(){fragColor=vec4(vY,0.,0.,1.);}`});
      scene.overrideMaterial=material;
      const c=new THREE.OrthographicCamera(-this.size/2,this.size/2,this.size/2,-this.size/2,.1,500);
      c.position.set(0,200,0);c.up.set(0,0,-1);c.lookAt(0,0,0);c.updateMatrixWorld();
      this.renderer.setRenderTarget(rt);this.renderer.setClearColor(0,0);this.renderer.clear();this.renderer.render(scene,c);
      this.renderer.readRenderTargetPixels(rt,0,0,n,n,top);this.renderer.setRenderTarget(null);
      // This camera maps +world-z to -image-y. Undo it for simulation indexing.
      const flipped=top.slice();for(let j=0;j<n;j++)top.set(flipped.subarray((n-1-j)*n*4,(n-j)*n*4),j*n*4);
      material.dispose();rt.dispose();
    }else for(let i=0;i<top.length;i+=4)top[i]=-preset.depth;
    this.maxDepth=0;
    for(let i=0;i<top.length;i+=4){const depth=Math.max(0,-top[i]);this.bedData[i]=depth>=.02?depth:0;this.bedData[i+3]=top[i];this.maxDepth=Math.max(this.maxDepth,depth);}
    const face=(a,b)=>a>=.02&&b>=.02?2*a*b/(a+b):0;
    for(let j=0;j<n;j++)for(let i=0;i<n;i++){
      const k=(j*n+i)*4,h=this.bedData[k];this.bedData[k+1]=i<n-1?face(h,this.bedData[k+4]):0;
      this.bedData[k+2]=j<n-1?face(h,this.bedData[k+n*4]):0;
    }
    this.bedTexture.needsUpdate=true;
  }
  topAt(x,z){
    const i=Math.max(0,Math.min(this.n-1,Math.floor((x/this.size+.5)*this.n))),j=Math.max(0,Math.min(this.n-1,Math.floor((z/this.size+.5)*this.n)));
    return this.bedData[(j*this.n+i)*4+3];
  }
  impulse(x,z,height=.12,radius=.6,foam=.08,momentum=[0,0]){
    if(![x,z,height,radius,foam,...momentum].every(Number.isFinite)||radius<=0)throw new RangeError('Nonfinite source or invalid radius');
    if(Math.abs(x)>this.size*.45||Math.abs(z)>this.size*.45)return false;
    const kernel=normalizedSource(x,z,radius,this.n,this.size,this.bedData,this.depth);
    if(!kernel.accepted)return false;
    if(this.events.length>=this.maxEvents)throw new RangeError('Source event capacity exceeded; refusing silent loss');
    this.events.push({x,z,height,radius:kernel.radius,foam,momentum,kernel});
    this.appliedImpulse[0]+=momentum[0];this.appliedImpulse[1]+=momentum[1];this.active=true;return true;
  }
  step(dt){
    if(!(dt>0&&Number.isFinite(dt)))throw new RangeError('Invalid interaction timestep');
    if(!this.active)return;
    const maxdt=.4*this.dx/Math.sqrt(2*9.81*Math.max(.02,this.maxDepth)),steps=Math.max(1,Math.ceil(dt/maxdt));
    const r=this.renderer,num=this.events.length;
    for(let i=0;i<num;i++){
      const e=this.events[i];this.pos.set([e.x,e.radius,e.z],i*3);this.data.set([e.height,e.momentum[0],e.momentum[1],e.foam],i*4);
      this.norms.set([e.kernel.mean,e.kernel.momentumX,e.kernel.momentumZ],i*3);
    }
    for(const name of ['aSource','aData','aNorm'])this.geometry.attributes[name].needsUpdate=true;
    this.geometry.instanceCount=num;r.setRenderTarget(this.sources);r.setClearColor(0,0);r.clear();if(num)r.render(this.sourceScene,this.camera);
    this.events.length=0;this.pass.uniforms.uDt.value=dt/steps;
    for(let sub=0;sub<steps;sub++)for(let stage=0;stage<2;stage++){
      this.pass.uniforms.uSourceScale.value=sub===0?1:0;this.pass.uniforms.uStage.value=stage;this.pass.uniforms.uState.value=this.a.texture;
      this.pass.run(r,this.b);[this.a,this.b]=[this.b,this.a];
    }
    r.setRenderTarget(null);this.count++;this.lastSubsteps=steps;
  }
  diagnostics() {
    const a = new Float32Array(this.n * this.n * 4);
    this.renderer.readRenderTargetPixels(this.a, 0, 0, this.n, this.n, a);
    let volume = 0,
      max = 0,
      energy = 0,
      finite = true;
    for (let i = 0; i < a.length; i += 4) {
      volume += a[i];
      max = Math.max(max, Math.abs(a[i]));
      energy +=
        0.5 * 9.81 * a[i] ** 2 +
        0.5 * (this.bedData[i+1]*a[i+1]**2+this.bedData[i+2]*a[i+2]**2);
      finite = finite && [a[i],a[i+1],a[i+2],a[i+3]].every(Number.isFinite);
    }
    return {
      grid: this.n,
      size: this.size,
      volumeResidual: volume * this.dx * this.dx,
      maxHeight: max,
      energy: energy * this.dx * this.dx,
      finite,
      appliedHorizontalImpulse: this.appliedImpulse,
      maximumDepth:this.maxDepth,substeps:this.lastSubsteps||0,
      model:"variable-depth linear shallow-water; no-flow solid columns",
    };
  }
}
/** Persistent foam density, age and entrainment proxy, driven by COMPOSED Jacobian.
 * All wave bands and their spectral derivatives are combined before foam is born.
 */
class WhitewaterField {
  constructor(renderer, ocean, interaction, n = 384, size = 256) {
    this.renderer = renderer;
    this.ocean = ocean;
    this.interaction = interaction;
    this.n = n;
    this.size = size;
    this.a=target(n,n,{linear:true,type:THREE.HalfFloatType});
    this.b=target(n,n,{linear:true,type:THREE.HalfFloatType});
    for(const rt of [this.a,this.b]){
      rt.texture.wrapS=rt.texture.wrapT=THREE.RepeatWrapping;
      rt.texture.minFilter=THREE.LinearMipmapLinearFilter;
      rt.texture.generateMipmaps=true;
    }
    this.pass=new Pass(`precision highp float;in vec2 vUv;out vec4 fragColor;
    ${waveDeclarations}
    uniform highp sampler2D uPrevious,uInteraction;
    uniform float uDt,uSize,uPatchSize,uThreshold,uGain,uLifetime,uResolution,uHs;
    uniform vec2 uWind;
    void main(){
      // q labels the horizontally displaced surface. This avoids world-to-wave
      // inversion at a fold and moves attached foam WITH its parent crest.
      vec2 q=(vUv-.5)*uSize;vec3 d,tx,tz,velocity;
      vec3 lod=max(vec3(0.),log2(max(vec3(.001),uSize/uResolution*uN/vec3(768.,96.,12.))));
      waveAt(q,lod,d,tx,tz,velocity);
      float J=tx.x*tz.z-tx.z*tz.x;
      vec2 point=q+d.xz,drift=uWind,puv=point/uPatchSize+.5;
      if(all(greaterThan(puv,vec2(.01)))&&all(lessThan(puv,vec2(.99))))drift+=sampleBilinear(uInteraction,puv).yz;
      float invJ=1./max(.25,J);
      vec2 materialFlow=vec2(tz.z*drift.x-tz.x*drift.y,-tx.z*drift.x+tx.x*drift.y)*invJ;
      vec2 back=vUv-materialFlow*uDt/uSize;
      vec4 old=textureLod(uPrevious,back,0.);
      float convergence=clamp((old.a-J)/max(.003,uDt),0.,3.);
      float crest=smoothstep(-uHs*.02,max(.001,uHs*.17),d.y);
      float compression=1.-smoothstep(uThreshold-.22,uThreshold,J);
      float source=compression*crest*(.20+.8*smoothstep(.025,.4,convergence))*uGain;
      float birth=1.-exp(-source*uDt*3.2);
      float retained=old.r*exp(-uDt/uLifetime);
      float foam=clamp(retained+(1.-retained)*birth,0.,1.);
      float newMass=foam-retained;
      float age=(old.g+uDt)*retained/max(foam,.00001);
      float aeration=max(old.b*exp(-uDt/.9),newMass/max(uDt,.003)*.42);
      fragColor=vec4(foam,foam>.0001?min(age,40.):0.,clamp(aeration,0.,1.),J);
    }`,{
      ...ocean.uniforms,uPrevious:U(this.a.texture),uInteraction:U(interaction.texture),
      uDt:U(1/60),uSize:U(size),uResolution:U(n),uPatchSize:U(interaction.size),
      uThreshold:U(.65),uGain:U(3),uLifetime:U(12),uHs:U(4),uWind:U(new THREE.Vector2())
    });
    this.reset();
  }
  get texture() {
    return this.a.texture;
  }
  reset() {
    for (const rt of [this.a, this.b]) {
      this.renderer.setRenderTarget(rt);
      this.renderer.setClearColor(0, 0);
      this.renderer.clear();
    }
    this.renderer.setRenderTarget(null);
  }
  step(dt, preset) {
    const u = this.pass.uniforms;
    u.uPrevious.value = this.a.texture;
    u.uInteraction.value = this.interaction.texture;
    u.uDt.value = dt;
    u.uHs.value = preset.hs;
    u.uThreshold.value = preset.foamThreshold;
    u.uGain.value = preset.foamGain;
    u.uLifetime.value = preset.foamLifetime;
    u.uWind.value.set(
      Math.cos(preset.direction) * preset.wind * 0.02,
      Math.sin(preset.direction) * preset.wind * 0.02,
    );
    this.pass.run(this.renderer, this.b);
    [this.a, this.b] = [this.b, this.a];
  }
}



return {InteractionField,WhitewaterField};
})();
__M["src/surface-shading.js"]=(()=>{

/** Shared surface-lighting evaluation used by primary raster visibility and by
 * traced reflection/refraction hits. No screen-colour lookup and no second,
 * incompatible material approximation for an off-screen object. */
const surfaceLightingGLSL = `
uniform highp sampler2D uRockDiffuse,uRockNormal,uSandDiffuse,uSandNormal,uCaustics,uShadowDepth;
uniform mat4 uShadowMatrix;uniform float uCausticSize,uCausticEnable,uPixelFootprint;
vec3 srgbDecode(vec3 c){return mix(c/12.92,pow((c+.055)/1.055,vec3(2.4)),greaterThan(c,vec3(.04045)));}
float sunlightVisibility(vec3 p,vec3 n){
 vec4 sc=uShadowMatrix*vec4(p+n*.035,1.);vec3 q=sc.xyz/sc.w*.5+.5;
 if(any(lessThan(q,vec3(.001)))||any(greaterThan(q,vec3(.999))))return 1.;
 float visibility=0.;for(int i=0;i<4;i++){vec2 off=vec2((i%2)==0?-.6:.6,i<2?-.6:.6)/1536.;float depth=texture(uShadowDepth,q.xy+off).r;visibility+=q.z-(.00045+.001*(1.-max(0.,dot(n,uSun))))<depth?1.:0.;}return visibility*.25;
}
vec3 surfaceRadiance(vec3 p,vec3 geomNormal,vec3 view,vec3 base,float kind){
 vec3 N=normalize(geomNormal),albedo=base;float distanceToEye=length(p-uEye);
 // An explicit ray-cone footprint is valid inside divergent BVH hit branches;
 // implicit texture derivatives there are undefined on some GPU backends.
 float cone=max(.00001,distanceToEye*uPixelFootprint)/max(.2,abs(dot(N,view)));
 float rockLod=clamp(log2(cone*float(textureSize(uRockDiffuse,0).x)/2.4),0.,8.);
 float sandLod=clamp(log2(cone*float(textureSize(uSandDiffuse,0).x)*.5),0.,8.);
 if(kind<.5){
  vec2 uv=p.xz*.5;vec3 sandTex=srgbDecode(textureLod(uSandDiffuse,uv,sandLod).rgb);
  float sandLuma=dot(sandTex,vec3(.2126,.7152,.0722));
  // Mineral reflectance with restrained real texture variation.
  float dune=.94+.06*sin(p.x*.51+p.z*.34+sin(p.z*.16));
  albedo=vec3(.52,.46,.35)*clamp(.68+1.25*sandLuma,.65,1.15)*dune;
  vec3 map=textureLod(uSandNormal,uv,sandLod).xyz*2.-1.;N=normalize(N+vec3(map.x,0.,map.y)*.23);
 }else if(kind<1.5){
  vec3 weights=pow(abs(N),vec3(6.));weights/=max(.001,weights.x+weights.y+weights.z);
  vec3 ax=srgbDecode(textureLod(uRockDiffuse,p.yz/2.4,rockLod).rgb),ay=srgbDecode(textureLod(uRockDiffuse,p.zx/2.4,rockLod).rgb),az=srgbDecode(textureLod(uRockDiffuse,p.xy/2.4,rockLod).rgb);
  vec3 rockTex=ax*weights.x+ay*weights.y+az*weights.z;
  float rockLuma=dot(rockTex,vec3(.2126,.7152,.0722));
  albedo=mix(rockTex,vec3(rockLuma),.62)*1.2+vec3(.042,.046,.047);
  float strata=.90+.1*smoothstep(-.5,.65,sin(p.y*3.8+p.x*.18+p.z*.27));
  albedo*=strata;
  // Reoriented surface-gradient detail, with a handed basis on each projection.
  vec3 bx=textureLod(uRockNormal,p.yz/2.4,rockLod).xyz*2.-1.,by=textureLod(uRockNormal,p.zx/2.4,rockLod).xyz*2.-1.,bz=textureLod(uRockNormal,p.xy/2.4,rockLod).xyz*2.-1.;
  vec3 gradient=vec3(0.,bx.x,bx.y)*weights.x+vec3(by.y,0.,by.x)*weights.y+vec3(bz.x,bz.y,0.)*weights.z;
  gradient-=N*dot(gradient,N);N=normalize(N+gradient*.20);
 }else if(kind>2.5&&kind<3.5){albedo*=.7+.22*noise2(p.xz*vec2(7.,.4));}
 float localSurface=displace(p.xz).y;
 float wet=1.-smoothstep(localSurface+.035,localSurface+.32,p.y);
 if(kind<1.5)albedo*=mix(1.,.66,wet);
 float depth=max(0.,localSurface-p.y);vec3 L;
 vec3 beam=directSolarTransfer(uSun,uAbsorption+uScattering,depth,depth>0.,solarVisibility(),L);
 vec3 shadowPoint=depth>0.?p+L*(depth/max(.001,L.y)):p;
 float shadow=sunlightVisibility(shadowPoint,N),nl=max(0.,dot(N,L));
 vec3 direct=uSunColor*beam*shadow;
 vec3 diffuse=skyDiffuse(N)*1.05+direct*nl/PI;
 if(depth>0.){
  vec2 cuv=p.xz/uCausticSize+.5;
  float focus=1.;
  if(uCausticEnable>.5){
   float edge=max(abs(cuv.x-.5),abs(cuv.y-.5));
   float atlasWeight=1.-smoothstep(.40,.48,edge);
   float focusLod=clamp(log2(max(1.,cone*float(textureSize(uCaustics,0).x)/uCausticSize)),0.,9.);
   float flux=clamp(textureLod(uCaustics,clamp(cuv,.001,.999),focusLod).r,.08,8.);
   focus=mix(1.,flux,atlasWeight);
  }
  // Caustics redistribute the direct term. They no longer add a second sun.
  diffuse=skyDiffuse(N)*.65*transmittance(depth*1.15)+direct*nl*mix(1.,focus,.82)/PI;
 }
 vec3 H=normalize(view+L);float nv=max(.001,dot(N,view));
 float rough=kind>3.5?.17:kind>1.5?.34:(kind<.5?.85:mix(.89,.51,wet));
 float a2=pow(rough,4.),nh=max(0.,dot(N,H)),den=nh*nh*(a2-1.)+1.;
 float D=a2/(PI*den*den),Gv=2.*nv/(nv+sqrt(a2+(1.-a2)*nv*nv)),Gl=2.*nl/(nl+sqrt(a2+(1.-a2)*nl*nl)+.0001);
 float F=.025+.975*pow(1.-max(0.,dot(view,H)),5.);
 // Both lobes receive the same occluded, refracted and attenuated beam.
 vec3 color=albedo*diffuse+direct*(D*Gv*Gl*F/max(.004,4.*nv));
 if(kind>3.5)color=mix(color,environmentRough(reflect(-view,N),rough)*albedo,.40);
 return max(color,vec3(0.));
}
`;



return {surfaceLightingGLSL};
})();
__M["src/water-shaders.js"]=(()=>{

const { raySceneGLSL }=__M["src/ray-scene.js"];
const { surfaceLightingGLSL }=__M["src/surface-shading.js"];
const { environmentGLSL }=__M["src/environment.js"];
const { waveDeclarations }=__M["src/gpu-ocean.js"];
const waterVertex = `precision highp float;in vec3 position;uniform mat4 projectionMatrix,modelViewMatrix;uniform mat4 uViewProjection;uniform float uPatchSize;uniform vec2 uTessellation;uniform highp sampler2D uInteraction;out vec3 vWorld;out vec2 vQ;
${environmentGLSL}
${waveDeclarations}
uniform float uOceanExtent,uOceanBase;
void main(){
 float r0=length(position.xz),fraction=log(1.+r0/11.)/log(1.+14000./11.);
 float r=uOceanBase*(exp(fraction*log(1.+uOceanExtent/uOceanBase))-1.);
 vec2 horizontal=position.xz*(r/max(r0,.00001));
 vec2 q=horizontal+uEye.xz;
 float spacing=max((r+uOceanBase)*log(1.+uOceanExtent/uOceanBase)/uTessellation.x,r*6.28318530718/uTessellation.y);
 vec3 lod=max(vec3(0.),log2(max(vec3(.001),spacing*uN/vec3(768.,96.,12.))));
 vec2 o=vec2(.5/uN);vec3 d=(textureLod(uDisplacement,vec3(q/768.+o,0.),lod.x).xyz+textureLod(uDisplacement,vec3(q/96.+o,1.),lod.y).xyz+textureLod(uDisplacement,vec3(q/12.+o,2.),lod.z).xyz)*uWaveScale;
 vec2 uv=(q+d.xz)/uPatchSize+.5;
 if(all(greaterThan(uv,vec2(.003)))&&all(lessThan(uv,vec2(.997))))d.y+=sampleBilinear(uInteraction,uv).x;
 vec3 p=vec3(q.x,0.,q.y)+d;vWorld=p;vQ=q;gl_Position=uViewProjection*vec4(p,1.);
}`;
const waterFragment = `precision highp float;precision highp int;in vec3 vWorld;in vec2 vQ;layout(location=0) out vec4 fragColor;layout(location=1) out vec4 motion;
${environmentGLSL}
${waveDeclarations}
uniform highp sampler2D uSceneColor,uSceneDepth,uReflection,uInteraction,uWhitewater,uFloorRadiance;uniform mat4 uFloorMatrix;
uniform mat4 uViewProjection,uInverseViewProjection,uViewMatrix,uReflectionMatrix,uHullInverse;
uniform vec2 uResolution;uniform float uPatchSize,uFoamSize,uRoughness,uWind,uUnderwater,uTerrain,uObjects,uBoat,uFoamEnable,uSprayEnable,uReflections;
uniform float uFoamThreshold,uHs;uniform vec2 uWindDirection;
uniform highp sampler2D uRainRing;uniform float uRainRingSize,uRainEnable;uniform int uDebug;
vec3 worldFromDepth(vec2 uv,float depth){vec4 p=uInverseViewProjection*vec4(uv*2.-1.,depth*2.-1.,1.);return p.xyz/p.w;}
bool inScreen(vec2 uv){return all(greaterThan(uv,vec2(.001)))&&all(lessThan(uv,vec2(.999)));}
${raySceneGLSL}
${surfaceLightingGLSL}
vec3 tracedRadiance(vec3 origin,vec3 direction,out float path,out bool hit){
 vec3 point,normal,albedo;float kind;
 hit=rayScene(origin,direction,point,normal,albedo,kind,path);
 return hit?surfaceRadiance(point,normal,-direction,albedo,kind):vec3(0.);
}
float smith(float n,float a2){return 2.*n/(n+sqrt(a2+(1.-a2)*n*n));}
// Seven deterministic solid-angle samples of the finite solar disc.
// uSunColor is beam-normal irradiance; the sky disc uses the same E / omega.
vec3 solarReflection(vec3 p,vec3 N,vec3 V,float alpha){
 vec3 bx=normalize(cross(uSun,abs(uSun.y)<.95?vec3(0.,1.,0.):vec3(1.,0.,0.))),by=cross(uSun,bx);
 float nv=max(.001,dot(N,V)),a2=alpha*alpha,total=0.;
 for(int i=0;i<7;i++){
  float a=float(i)*2.39996323,rad=.00465*sqrt((float(i)+.5)/7.);
  vec3 L=normalize(uSun+rad*(cos(a)*bx+sin(a)*by)),H=normalize(V+L);float nl=max(0.,dot(N,L));
  if(nl>0.){float nh=max(0.,dot(N,H)),den=nh*nh*(a2-1.)+1.,D=a2/(PI*den*den);
   total+=D*smith(nv,a2)*smith(nl,a2)*dielectric(max(0.,dot(V,H)),1.,1.333)/(4.*nv);
  }
 }
 return uSunColor*min(total/7.,1./.0000679)*solarVisibility()*sunlightVisibility(p,N);
}
void main(){
 if(uTerrain>.5&&vWorld.y<bedHeight(vWorld.xz)-.025)discard;
 if(uBoat>.5){vec3 h=(uHullInverse*vec4(vWorld,1.)).xyz;float width=.99*sqrt(max(0.,1.-pow((h.x+.20)/3.65,2.)));if(abs(h.x)<3.35&&abs(h.z)<width&&h.y>-.31&&h.y<.95)discard;}
 float footprint=max(length(dFdx(vQ)),length(dFdy(vQ)));vec3 lod=max(vec3(0.),log2(max(vec3(.001),footprint*uN/vec3(768.,96.,12.))));
 vec3 d,tx,tz,velocity;waveAt(vQ,lod,d,tx,tz,velocity);vec2 puv=vWorld.xz/uPatchSize+.5;vec4 response=vec4(0.);float patchWindow=0.;
 if(all(greaterThan(puv,vec2(.005)))&&all(lessThan(puv,vec2(.995)))){
  response=sampleBilinear(uInteraction,puv);float eps=1./256.;float dx=uPatchSize*eps;
  vec2 slope=vec2(sampleBilinear(uInteraction,puv+vec2(eps,0.)).x-sampleBilinear(uInteraction,puv-vec2(eps,0.)).x,sampleBilinear(uInteraction,puv+vec2(0.,eps)).x-sampleBilinear(uInteraction,puv-vec2(0.,eps)).x)/(2.*dx);
  tx.y+=dot(slope,tx.xz);tz.y+=dot(slope,tz.xz);patchWindow=1.;
 }
 float rainReactive=0.;
 if(uRainEnable>.5){vec2 ruv=vWorld.xz/uRainRingSize+.5;if(inScreen(ruv)){vec4 rings=texture(uRainRing,ruv);tx.y+=dot(rings.xy,tx.xz);tz.y+=dot(rings.xy,tz.xz);rainReactive=length(rings.xy);}}
 float dist=length(vWorld-uEye);float microFade=1.-smoothstep(4.,45.,dist);
 // Integrate unresolved capillary slope over the pixel footprint and exposure.
 float microVariance=0.;
 for(int i=0;i<5;i++){
  float fi=float(i),wl=.055+fi*.031,k=6.28318530718/wl;vec2 dir=vec2(cos(fi*2.399),sin(fi*2.399));
  float omega=sqrt(9.81*k+.000074*k*k*k),amp=.009*(.3+min(uWind/9.,1.));
  float spatial=1.-smoothstep(.12,.48,footprint/wl),q=.5*omega*uShutter,temporal=q>.001?sin(q)/q:1.;
  float waveFilter=spatial*temporal*microFade;
  float a=amp*cos(dot(dir,vQ)*k-uTime*omega)*waveFilter;
  tx.y+=dir.x*a;tz.y+=dir.y*a;microVariance+=.5*amp*amp*(1.-waveFilter*waveFilter);
 }
 vec3 N=normalize(cross(tz,tx)),V=normalize(uEye-vWorld);if(uUnderwater>.5)N=-N;
 // The pixel-filtered normal and the coarser geometric silhouette can disagree.
 // Do not flip an above-water shading normal downward: that extinguishes foam
 // lighting and draws black slits through an otherwise visible crest. Blend
 // back to the actual triangle normal inside a narrow view-facing cone.
 vec3 Ng=normalize(cross(dFdx(vWorld),dFdy(vWorld)));if(dot(Ng,V)<0.)Ng=-Ng;
 float align=dot(N,V),ngv=dot(Ng,V);if(align<.035){float blend=clamp((.035-align)/max(.0001,ngv-align),0.,1.);N=normalize(mix(N,Ng,blend));}
 bool under=uUnderwater>.5;float etaI=under?1.333:1.,etaT=under?1.:1.333;
 float NoV=max(.001,dot(N,V)),F=dielectric(NoV,etaI,etaT);vec3 R=reflect(-V,N),T=refract(-V,N,etaI/etaT);
 float variance=.5*(dot(dFdx(N),dFdx(N))+dot(dFdy(N),dFdy(N)));
 float alpha=clamp(uRoughness*uRoughness+.003+microVariance+variance*.65+.018*smoothstep(.15,3.,footprint),.003,.28),rough=sqrt(alpha);
 vec3 reflected=environmentRough(R,rough);float reflectedLength=0.;
 if(uObjects>.5&&uReflections>.5){
  bool reflectionHit=false;vec3 radiance=tracedRadiance(vWorld+N*.012,R,reflectedLength,reflectionHit);
  if(reflectionHit)reflected=radiance;
  if(!reflectionHit)reflectedLength=80.;
 }
 if(under){float len=reflectedLength>0.?reflectedLength:80.;reflected=reflected*transmittance(len)+waterInscatter(R,len);}
 if(!under&&R.y<-.001){float closure=smoothstep(0.,.32,-R.y);reflected=mix(reflected,waterInscatter(R,50.),closure);}
 vec3 transmitted=vec3(0.);float opticalDistance=110.;
 if(length(T)>.001){
  bool transmissionHit=false;
  vec3 radiance=uObjects>.5?tracedRadiance(vWorld-N*.012,T,opticalDistance,transmissionHit):vec3(0.);
  if(under){transmitted=transmissionHit?radiance:environmentRough(T,rough*.25);opticalDistance=0.;}
  else {if(!transmissionHit)opticalDistance=min(250.,max(0.,vWorld.y-bedHeight(vWorld.xz))/max(.08,-T.y));
    transmitted=radiance*transmittance(opticalDistance)+waterInscatter(T,opticalDistance);
  }
 }
 vec3 color=reflected*F+transmitted*(1.-F);
 if(!under)color+=solarReflection(vWorld,N,V,alpha);
 float jac=tx.x*tz.z-tx.z*tz.x;
 // The history is toroidal over the full 768m spectral period. No square mask.
 vec4 white=texture(uWhitewater,vQ/uFoamSize+.5);
 float foam=clamp(white.r+response.w*.8,0.,1.);
 float age=clamp(white.g/18.,0.,1.);
 float recent=white.b;
 vec2 wind=normalize(uWindDirection),side=vec2(-wind.y,wind.x);
 vec2 material=vQ-wind*uTime*uWind*.016;
 vec2 streak=vec2(dot(material,wind)*.012,dot(material,side)*.060);
 vec4 broad=texture(uMicro,streak),grain=texture(uMicro,material*.046+vec2(.31,.73));
 vec4 cells=texture(uMicro,material*.34),fine=texture(uMicro,material*1.4);
 // Foam thickness becomes coverage with multiscale perforation, not an opaque
 // thresholded checkerboard. Fine cells average out with pixel footprint.
 float variation=clamp(.5+2.7*(.56*broad.a+.44*grain.a-.5),0.,1.);
 float maturity=1.-exp(-white.g*.24);
 float density=(1.-exp(-foam*2.8))*(1.-maturity*.12)+recent*.08;
 float threshold=.16+.90*variation+maturity*.04;
 float aa=max(.060,fwidth(density-threshold)*1.4);
 float raft=smoothstep(threshold-aa,threshold+aa,density);
 float fineFade=1.-smoothstep(.08,.55,footprint);
 float microStructure=mix(1.,.68+.32*max(cells.b,cells.g),fineFade);
 float lace=(cells.g*.65+fine.g*.35)*foam*.28*fineFade;
 float distant=(1.-exp(-foam*1.20))*(1.-maturity*.20);
 float cover=mix(raft*microStructure+lace,distant,smoothstep(.7,4.,footprint));
 cover*=uFoamEnable;
 vec3 fN=normalize(mix(N,vec3(0.,under?-1.:1.,0.),.18));
 vec3 foamRadiance=(skyDiffuse(fN)+uSunColor*max(0.,dot(fN,uSun))/PI*solarVisibility()*sunlightVisibility(vWorld,fN))*.83;
 foamRadiance*=.86+.14*mix(1.,fine.b,fineFade);
 if(under)foamRadiance*=.5;
 // A thin sub-surface aeration layer remains beneath the diminishing surface raft.
 float aeration=clamp(recent*.22+foam*.06,0.,.3)*(1.-F)*uFoamEnable;
 color=mix(color,foamRadiance*vec3(.48,.69,.70),aeration);
 color=mix(color,foamRadiance,clamp(cover,0.,.98));
 if(!under){float altitude=max(0.,uEye.y)/1600.;float airFraction=altitude<.001?1.:(1.-exp(-altitude))/altitude;float haze=1.-exp(-dist*airFraction*(uWind>15.?.00018:.00004));color=mix(color,environment(normalize(vec3(vWorld.x-uEye.x,.015,vWorld.z-uEye.z))),haze);}
 if(uDebug==1)color=N*.5+.5;
 if(uDebug==2)color=jac<0.?vec3(1.,0.,1.):mix(vec3(.015,.09,.30),vec3(1.,.28,.018),clamp(1.-jac,0.,1.));
 if(uDebug==3)color=vec3(1.-exp(-opticalDistance*.13),exp(-opticalDistance*.08),exp(-opticalDistance*.02))*.65;
 if(uDebug==4)color=vec3(foam,clamp(white.g/15.,0.,1.)*foam,white.b*3.);
 if(uDebug==5)color=vec3(.2)+abs(velocity)*.14;
 if(uDebug==6)color=vec3(.03,.12,.2)+vec3(max(0.,response.x)*2.,response.w*.8,max(0.,-response.x)*2.);
 fragColor=vec4(max(color,vec3(0.)),(rainReactive>.002||cover>.035||abs(response.x)>.006)?.8:1.);motion=vec4(velocity+vec3(response.y,0.,response.z),1.);
}`;
const skyVertex = `precision highp float;in vec3 position;uniform mat4 projectionMatrix,modelViewMatrix,modelMatrix;out vec3 vWorld;void main(){vWorld=(modelMatrix*vec4(position,1.)).xyz;gl_Position=projectionMatrix*modelViewMatrix*vec4(position,1.);}`;
const skyFragment = `precision highp float;in vec3 vWorld;layout(location=0) out vec4 fragColor;layout(location=1) out vec4 objectMotion;${environmentGLSL}
void main(){vec3 d=normalize(vWorld-uEye);vec3 c=environment(d);float angle=acos(clamp(dot(d,uSun),-1.,1.));float disk=1.-smoothstep(.0041,.005,angle);c+=uSunColor*(disk/.0000679)*solarVisibility();c+=uSunColor*.018*exp(-angle*23.);fragColor=vec4(c,0.);objectMotion=vec4(0.);}`;
const objectVertex = `precision highp float;in vec3 position,normal;uniform mat4 projectionMatrix,modelViewMatrix,modelMatrix,viewMatrix;uniform mat3 normalMatrix;out vec3 vWorld,vNormal;void main(){vWorld=(modelMatrix*vec4(position,1.)).xyz;vNormal=normalize(mat3(transpose(viewMatrix))*normalMatrix*normal);gl_Position=projectionMatrix*modelViewMatrix*vec4(position,1.);}`;
const objectFragment = `precision highp float;in vec3 vWorld,vNormal;layout(location=0) out vec4 fragColor;layout(location=1) out vec4 objectMotion;
${environmentGLSL}
${waveDeclarations}
${surfaceLightingGLSL}
uniform vec3 uAlbedo;uniform float uKind,uClip,uUnderwater;
void main(){if(uClip>.5&&vWorld.y<-.03)discard;vec3 N=normalize(vNormal);if(!gl_FrontFacing)N=-N;
 fragColor=vec4(surfaceRadiance(vWorld,N,normalize(uEye-vWorld),uAlbedo,uKind),.5);objectMotion=vec4(0.);
}`;



return {waterVertex,waterFragment,skyVertex,skyFragment,objectVertex,objectFragment};
})();
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
__M["src/world.js"]=(()=>{

const { THREE, uniform:U }=__M["src/gpu.js"];
const {
  objectVertex,
  objectFragment,
  skyVertex,
  skyFragment,
}=__M["src/water-shaders.js"];
const { bedHeightJS }=__M["src/environment.js"];
const { mulberry32 }=__M["src/math.js"];
function noise3(x, y, z) {
  const i = Math.floor(x),
    j = Math.floor(y),
    k = Math.floor(z);
  x -= i;
  y -= j;
  z -= k;
  x = x * x * (3 - 2 * x);
  y = y * y * (3 - 2 * y);
  z = z * z * (3 - 2 * z);
  const h = (a, b, c) => {
    let v =
      Math.imul(a, 73856093) ^ Math.imul(b, 19349663) ^ Math.imul(c, 83492791);
    v = Math.imul(v ^ (v >>> 13), 1274126177);
    return ((v ^ (v >>> 16)) >>> 0) / 4294967296;
  };
  let sum = 0;
  for (let a = 0; a < 2; a++)
    for (let b = 0; b < 2; b++)
      for (let c = 0; c < 2; c++)
        sum +=
          h(i + a, j + b, k + c) *
          (a ? x : 1 - x) *
          (b ? y : 1 - y) *
          (c ? z : 1 - z);
  return sum;
}
class World {
  constructor(shared) {
    this.shared = shared;
    this.scene = new THREE.Scene();
    this.materials = [];
    this.terrainGroup = new THREE.Group();
    this.floatingGroup = new THREE.Group();
    this.scene.add(this.terrainGroup, this.floatingGroup);
    const skyMat = new THREE.RawShaderMaterial({
      glslVersion: THREE.GLSL3,
      vertexShader: skyVertex,
      fragmentShader: skyFragment,
      uniforms: shared,
      side: THREE.BackSide,
      depthWrite: false,
      depthTest: false,
    });
    this.sky = new THREE.Mesh(new THREE.SphereGeometry(19000, 24, 12), skyMat);
    this.sky.frustumCulled = false;
    this.sky.renderOrder = -100;
    this.scene.add(this.sky);
    this.material = ({ color = [0.5, 0.48, 0.4], kind = 1 } = {}) => {
      const mat = new THREE.RawShaderMaterial({
        glslVersion: THREE.GLSL3,
        vertexShader: objectVertex,
        fragmentShader: objectFragment,
        uniforms: {
          ...shared,
          uAlbedo: U(new THREE.Vector3(...color)),
          uKind: U(kind),
        },
        side: THREE.DoubleSide,
      });
      this.materials.push(mat);
      return mat;
    };
    this.sand = this.material({ color: [0.59, 0.53, 0.38], kind: 0 });
    this.rock = this.material({ color: [0.43, 0.415, 0.36], kind: 1 });
    this.darkRock = this.material({ color: [0.34, 0.345, 0.3], kind: 1 });
    this.white = this.material({ color: [0.73, 0.76, 0.74], kind: 2 });
    this.wood = this.material({ color: [0.24, 0.14, 0.063], kind: 3 });
    this.metal = this.material({ color: [0.5, 0.56, 0.59], kind: 4 });
    this.glass = this.material({ color: [0.032, 0.078, 0.089], kind: 4 });
    this.black = this.material({ color: [0.018, 0.023, 0.027], kind: 2 });
    const ground = new THREE.PlaneGeometry(340, 340, 256, 256);
    ground.rotateX(-Math.PI / 2);
    this.ground = new THREE.Mesh(ground, this.sand);
    this.terrainGroup.add(this.ground);
    this.makeRocks();
    this.boat = this.makeBoat();
    this.floatingGroup.add(this.boat);
    this.buoyModels = [this.makeBuoy(), this.makeCrate(), this.makeBuoy(true)];
    this.floatingGroup.add(...this.buoyModels);
    this.depthMarkers = new THREE.Group();
    this.depthMarkers.name = "Calibration markers";
    this.terrainGroup.add(this.depthMarkers);
    for (let i = 0; i < 4; i++) {
      const g = new THREE.Group();
      const color = this.material({
        color: [
          [0.58, 0.047, 0.022],
          [0.045, 0.29, 0.57],
          [0.57, 0.4, 0.022],
          [0.62, 0.62, 0.61],
        ][i],
        kind: 2,
      });
      for (let j = 0; j < 4; j++) {
        const b = new THREE.Mesh(
          new THREE.BoxGeometry(1.5, 0.25, 0.8),
          j % 2 ? this.white : color,
        );
        b.position.y = j * 0.25;
        g.add(b);
      }
      g.position.set(-19 + i * 10, -2 - i * 0.5, -8);
      this.depthMarkers.add(g);
    }
  }
  box(parent, size, pos, mat) {
    const m = new THREE.Mesh(new THREE.BoxGeometry(...size), mat);
    m.position.set(...pos);
    parent.add(m);
    return m;
  }
  cylinder(parent, r1, r2, height, pos, mat, segments = 24) {
    const m = new THREE.Mesh(
      new THREE.CylinderGeometry(r1, r2, height, segments),
      mat,
    );
    m.position.set(...pos);
    parent.add(m);
    return m;
  }
  tube(parent, points, radius, mat) {
    const curve = new THREE.CatmullRomCurve3(
      points.map((p) => new THREE.Vector3(...p)),
    );
    const m = new THREE.Mesh(
      new THREE.TubeGeometry(
        curve,
        Math.max(12, points.length * 6),
        radius,
        6,
        false,
      ),
      mat,
    );
    parent.add(m);
    return m;
  }
  makeRocks() {
    const rng = mulberry32(46209);
    this.rocks = [];
    const add = (x, y, z, sx, sy, sz, index) => {
      const geo = new THREE.SphereGeometry(
          1,
          index < 13 ? 56 : 24,
          index < 13 ? 36 : 16,
        ),
        a = geo.attributes.position;
      for (let i = 0; i < a.count; i++) {
        const px = a.getX(i),
          py = a.getY(i),
          pz = a.getZ(i),
          n =
            0.47 * (noise3(px * 2.4 + index * 11, py * 2.4, pz * 2.4) - 0.5) +
            0.15 * (noise3(px * 7.2, py * 7.2 + index * 7, pz * 7.2) - 0.5) +
            0.055 * (noise3(px * 20, py * 20, pz * 20 + index * 3) - 0.5);
        const block = Math.pow(Math.pow(Math.abs(px), 4) + Math.pow(Math.abs(py), 4) + Math.pow(Math.abs(pz), 4), -0.25);
        const shape = 0.65 + 0.35 * Math.min(1.5, block);
        const strata = 1 - 0.045 * Math.pow(Math.abs(Math.sin(py * 13.5 + px * 1.4 + pz * 0.8 + index)), 0.45);
        const fracture = Math.min(1, 0.94 / Math.max(.01, Math.abs(px * .79 + py * .41 + pz * .45)));
        const r = shape * strata * fracture;
        a.setXYZ(i, px * r * (1 + n * 1.15), py * r * (1 + n * .5), pz * r * (1 + n * 1.15));
      }
      geo.computeVertexNormals();
      const m = new THREE.Mesh(
        geo,
        index % 4 === 0 ? this.darkRock : this.rock,
      );
      m.position.set(x, y, z);
      m.userData.designedY = y;
      m.scale.set(sx, sy, sz);
      m.rotation.set(rng() * 0.2, rng() * 6.28, rng() * 0.15);
      this.terrainGroup.add(m);
      this.rocks.push(m);
    };
    [
      [-23, 1.0, -17, 6, 5, 5],
      [-29, 3, -29, 7, 8, 6],
      [-33, 7, -41, 7, 11, 8],
      [-22, 5, -43, 6, 10, 6],
      [-13, 3, -46, 6, 7, 5],
      [31, 2, -26, 8, 7, 7],
      [39, 6, -39, 8, 12, 8],
      [25, 6, -49, 7, 11, 8],
      [14, 3, -52, 9, 7, 6],
      [-10, -2.8, -8, 2.2, 2.2, 2.7],
      [8, -4, -2, 2.6, 2.2, 2.1],
      [17, -2.6, -22, 2.9, 3.3, 3.1],
      [-24, -0.1, 0, 2.6, 3.2, 3.7],
    ].forEach((v, i) => add(...v, i));
    for (let i = 0; i < 50; i++) {
      let x = (rng() - 0.5) * 80,
        z = -25 - rng() * 35;
      const rad = 0.35 + rng() * 1.7;
      add(x, -1.6 + rng() * 1.5, z, rad, rad * 0.8, rad * 1.2, i + 20);
    }
    for (let i = 0; i < 30; i++) {
      const x = (rng() - 0.5) * 70,
        z = (rng() - 0.5) * 30,
        r = 0.14 + rng() * 0.5;
      add(x, -4.6 - 0.072 * x - 0.022 * z, z, r, r * 0.55, r * 1.1, i + 90);
    }
  }
  makeBoat() {
    const g = new THREE.Group();
    g.name = "Dynamic 7 m motor launch";
    const vertices = [],
      indices = [];
    const nx = 52,
      nc = 24;
    for (let i = 0; i <= nx; i++) {
      const s = i / nx,
        x = (s - 0.5) * 7,
        w = 1.08 * Math.pow(Math.sin(Math.PI * s), 0.45) * (1 - 0.15 * s);
      for (let j = 0; j <= nc; j++) {
        const a = (j / nc) * Math.PI,
          z = w * Math.cos(a),
          y =
            0.42 -
            0.91 *
              Math.pow(Math.sin(a), 0.85) *
              (0.8 + 0.2 * Math.sin(Math.PI * s));
        vertices.push(x, y, z);
      }
    }
    for (let i = 0; i < nx; i++)
      for (let j = 0; j < nc; j++) {
        const a = i * (nc + 1) + j,
          b = a + nc + 1;
        indices.push(a, a + 1, b, a + 1, b + 1, b);
      }
    const hull = new THREE.BufferGeometry();
    hull.setAttribute(
      "position",
      new THREE.Float32BufferAttribute(vertices, 3),
    );
    hull.setIndex(indices);
    hull.computeVertexNormals();
    g.add(new THREE.Mesh(hull, this.white));
    const deck = [];
    for (let i = 0; i < nx; i++) {
      for (const si of [i / nx, (i + 1) / nx]) {
        const x = (si - 0.5) * 7,
          w = 1.07 * Math.pow(Math.sin(Math.PI * si), 0.45) * (1 - 0.15 * si);
        deck.push([x, 0.43, -w], [x, 0.43, w]);
      }
    }
    const dv = [];
    for (let i = 0; i < deck.length; i += 4)
      for (const q of [
        deck[i],
        deck[i + 1],
        deck[i + 2],
        deck[i + 1],
        deck[i + 3],
        deck[i + 2],
      ])
        dv.push(...q);
    const dg = new THREE.BufferGeometry();
    dg.setAttribute("position", new THREE.Float32BufferAttribute(dv, 3));
    dg.computeVertexNormals();
    g.add(new THREE.Mesh(dg, this.wood));
    this.box(g, [2.9, 0.18, 1.62], [-0.7, 0.5, 0], this.white);
    this.box(g, [2.5, 0.07, 1.3], [-0.75, 0.61, 0], this.black);
    for (const x of [-1.55, -0.2]) {
      this.box(g, [0.44, 0.22, 0.65], [x, 0.75, 0], this.white);
      this.box(g, [0.15, 0.53, 0.68], [x - 0.18, 1.02, 0], this.white);
    }
    this.box(g, [0.48, 0.48, 1.36], [0.72, 0.77, 0], this.white);
    const screen = this.box(g, [0.065, 0.53, 1.4], [0.85, 1.28, 0], this.glass);
    screen.rotation.z = -0.3;
    this.box(g, [1.27, 0.05, 0.97], [2, 0.49, 0], this.white);
    for (const side of [-1, 1]) {
      this.tube(
        g,
        [
          [-2.8, 0.65, side * 0.64],
          [-1.9, 0.89, side * 0.97],
          [0, 0.9, side * 0.98],
          [1.6, 0.9, side * 0.74],
          [2.65, 0.7, side * 0.4],
          [3.35, 0.6, 0],
        ],
        0.024,
        this.metal,
      );
      for (const x of [-2, -0.5, 1.0])
        this.tube(
          g,
          [
            [x, 0.44, side * 0.89],
            [x, 0.89, side * 0.89],
          ],
          0.018,
          this.metal,
        );
      const rub = this.tube(
        g,
        [
          [-3.45, 0.34, 0],
          [-2.6, 0.37, side * 0.72],
          [0, 0.39, side * 0.99],
          [2.6, 0.38, side * 0.54],
          [3.45, 0.33, 0],
        ],
        0.04,
        this.black,
      );
    }
    this.box(g, [0.63, 0.76, 0.56], [-3.15, 0.45, 0], this.black);
    this.box(g, [0.34, 0.78, 0.26], [-3.28, -0.16, 0], this.black);
    this.cylinder(
      g,
      0.18,
      0.18,
      0.05,
      [-3.29, -0.52, 0],
      this.metal,
    ).rotation.x = Math.PI / 2;
    for (const z of [-0.61, 0.61])
      this.box(g, [0.18, 0.065, 0.09], [0.97, 0.91, z], this.metal);
    return g;
  }
  makeBuoy(small = false) {
    const g = new THREE.Group(),
      r = small ? 0.65 : 0.9;
    const yellow = this.material({ color: [0.65, 0.34, 0.016], kind: 2 });
    this.cylinder(g, r, r * 0.88, 0.42, [0, 0, 0], this.black);
    this.cylinder(g, r * 0.82, r * 0.95, 0.34, [0, 0.32, 0], yellow);
    this.cylinder(g, r * 0.3, r * 0.38, 1.0, [0, 0.98, 0], yellow);
    this.cylinder(g, 0.07, 0.07, 0.5, [0, 1.66, 0], this.metal);
    this.cylinder(g, 0.13, 0.13, 0.14, [0, 1.98, 0], this.glass);
    for (let i = 0; i < 4; i++) {
      const a = i * Math.PI * 0.5;
      this.tube(
        g,
        [
          [Math.cos(a) * r * 0.7, 0.5, Math.sin(a) * r * 0.7],
          [Math.cos(a) * r * 0.3, 1.3, Math.sin(a) * r * 0.3],
        ],
        0.026,
        this.metal,
      );
    }
    return g;
  }
  makeCrate() {
    const g = new THREE.Group();
    for (let i = 0; i < 7; i++)
      this.box(g, [1.65, 0.095, 0.205], [0, 0.19, (i - 3) * 0.23], this.wood);
    for (const z of [-0.68, 0.68])
      this.box(g, [1.65, 0.35, 0.14], [0, -0.03, z], this.wood);
    for (const x of [-0.65, 0.65])
      this.box(g, [0.14, 0.33, 1.5], [x, -0.02, 0], this.wood);
    this.box(g, [0.64, 0.38, 0.69], [0.18, 0.44, 0.16], this.black);
    return g;
  }
  groundRocks(p) {
    if (!p.terrain) return;
    const key = p.bed.join(",");
    if (key === this.rockPlacementKey) return;
    let corrected = 0,
      maximumOriginalGap = 0,
      maximumRemainingGap = -Infinity;
    const point = new THREE.Vector3();
    for (const mesh of this.rocks) {
      // Always start from the authored placement, not a previous preset's result.
      mesh.position.y = mesh.userData.designedY;
      mesh.updateWorldMatrix(true, false);
      const a = mesh.geometry.attributes.position;
      let gap = Infinity;
      for (let i = 0; i < a.count; i++) {
        point.fromBufferAttribute(a, i).applyMatrix4(mesh.matrixWorld);
        gap = Math.min(gap, point.y - bedHeightJS(point.x, point.z, p.bed));
      }
      maximumOriginalGap = Math.max(maximumOriginalGap, gap);
      const embed = Math.min(0.65, Math.max(0.06, mesh.scale.y * 0.24));
      if (gap > -embed) {
        mesh.position.y -= gap + embed;
        mesh.updateWorldMatrix(true, false);
        corrected++;
        gap = -embed;
      }
      maximumRemainingGap = Math.max(maximumRemainingGap, gap);
    }
    this.rockPlacementKey = key;
    this.groundingReport = {
      rocks: this.rocks.length,
      corrected,
      maximumOriginalGap,
      maximumRemainingGap,
      bed: p.bed.slice(),
      scope:
        "Deterministic downward placement against the analytic bed, with shallow embedding. Not a granular-contact solver.",
    };
  }
  configure(p) {
    this.groundRocks(p);
    this.terrainGroup.visible = p.terrain;
    this.boat.visible = p.boat;
    this.buoyModels.forEach((m) => (m.visible = p.buoys));
    this.depthMarkers.visible = false;
    const a = this.ground.geometry.attributes.position;
    for (let i = 0; i < a.count; i++)
      a.setY(i, bedHeightJS(a.getX(i), a.getZ(i), p.bed));
    a.needsUpdate = true;
    this.ground.geometry.computeVertexNormals();
    this.ground.geometry.computeBoundingSphere();
    for (let i = 0; i < this.depthMarkers.children.length; i++) {
      const m = this.depthMarkers.children[i];
      m.position.y = bedHeightJS(m.position.x, m.position.z, p.bed) + 0.06;
    }
  }
}



return {World};
})();
__M["src/shadows.js"]=(()=>{

const { THREE, target, uniform:U }=__M["src/gpu.js"];
/** Scene-geometry directional shadow map. The same meshes that are visible and
 * refracted cast shadows; no hard-coded sphere or rock shadow intersections. */
class WorldShadows {
  constructor(renderer, world, shared) {
    this.renderer = renderer;
    this.world = world;
    this.shared = shared;
    this.target = target(1536, 1536, {
      type: THREE.UnsignedByteType,
      depth: true,
    });
    this.camera = new THREE.OrthographicCamera(-90, 90, 90, -90, 0.1, 420);
    this.matrix = new THREE.Matrix4();
    shared.uShadowDepth.value = this.target.depthTexture;
    shared.uShadowMatrix.value = this.matrix;
    this.material = new THREE.RawShaderMaterial({
      glslVersion: THREE.GLSL3,
      vertexShader: `precision highp float;in vec3 position;uniform mat4 projectionMatrix,modelViewMatrix;void main(){gl_Position=projectionMatrix*modelViewMatrix*vec4(position,1.);}`,
      fragmentShader: `precision highp float;out vec4 fragColor;void main(){fragColor=vec4(0.);}`,
      side: THREE.DoubleSide,
    });
  }
  render() {
    const { renderer: r, world: w, camera: c } = this,
      sun = this.shared.uSun.value;
    c.position.copy(sun).multiplyScalar(190);
    c.position.z -= 15;
    c.lookAt(0, 0, -15);
    c.updateMatrixWorld();
    this.matrix.multiplyMatrices(c.projectionMatrix, c.matrixWorldInverse);
    const old = w.scene.overrideMaterial;
    w.scene.overrideMaterial = this.material;
    w.sky.visible = false;
    r.setRenderTarget(this.target);
    r.setClearColor(0, 0);
    r.clear();
    r.render(w.scene, c);
    w.sky.visible = true;
    w.scene.overrideMaterial = old;
    r.setRenderTarget(null);
  }
}



return {WorldShadows};
})();
__M["src/caustics.js"]=(()=>{
const { THREE, Pass, target, uniform:U }=__M["src/gpu.js"];
const { environmentGLSL }=__M["src/environment.js"];
const { waveDeclarations }=__M["src/gpu-ocean.js"];

/** Continuous refracted-ray mesh, not a lattice of independent point sprites.
 * Each source triangle transports a footprint into the receiver atlas. The
 * fragment Jacobian gives relative irradiance; folds accumulate additively.
 * Flat interfaces map to unit intensity, independent of the sampling lattice.
 * The bounded atlas follows the analytic seabed, not arbitrary receiver depths.
 */
class Caustics {
  constructor(renderer, ocean, shared, quality = 256, size = 96) {
    this.renderer = renderer;
    this.size = size;
    this.n = quality >= 256 ? 512 : 320;
    this.resolution = quality >= 256 ? 1024 : 768;
    this.sourceSize = size + 24;
    this.raw = target(this.resolution, this.resolution, {type: THREE.HalfFloatType, linear:true});
    this.temp = target(this.resolution, this.resolution, {type: THREE.HalfFloatType, linear:true});
    this.target = target(this.resolution, this.resolution, {type: THREE.HalfFloatType, linear:true});
    this.target.texture.generateMipmaps = true;
    this.target.texture.minFilter = THREE.LinearMipmapLinearFilter;
    const cell = this.sourceSize / this.n;
    const lod = [768,96,12].map(length => Math.max(0,Math.log2(cell*1.7/(length/ocean.n))));
    this.uniforms = {...shared,...ocean.uniforms,
      uCausticSize:U(size), uCausticResolution:U(this.resolution),
      uPhotonLod:U(new THREE.Vector3(...lod)),uCausticFlatTest:U(0),
      uCausticOffset:U(new THREE.Vector2(0,0))};
    const geo = new THREE.PlaneGeometry(this.sourceSize,this.sourceSize,this.n,this.n);
    geo.rotateX(-Math.PI/2);
    this.material = new THREE.RawShaderMaterial({
      glslVersion:THREE.GLSL3, uniforms:this.uniforms, depthTest:false,
      depthWrite:false, side:THREE.DoubleSide, transparent:true,
      blending:THREE.CustomBlending, blendEquation:THREE.AddEquation,
      blendSrc:THREE.OneFactor, blendDst:THREE.OneFactor,
      vertexShader:`precision highp float;precision highp int;
        in vec3 position;out vec2 vReference;out float vFlux;
        uniform float uCausticSize,uCausticFlatTest;
        uniform vec3 uPhotonLod;uniform vec2 uCausticOffset;
        ${environmentGLSL}
        ${waveDeclarations}
        vec3 receiver(vec3 p,vec3 ray){
          float t=max(0.,(bedHeight(p.xz)-p.y)/min(-.05,ray.y));
          for(int i=0;i<5;i++)t=max(0.,(bedHeight(p.xz+ray.xz*t)-p.y)/min(-.05,ray.y));
          return p+ray*t;
        }
        void main(){
          vec2 q=position.xz+uCausticOffset;vec3 d,tx,tz,vel;
          waveAt(q,uPhotonLod,d,tx,tz,vel);
          if(uCausticFlatTest>.5){d=vec3(0.);tx=vec3(1.,0.,0.);tz=vec3(0.,0.,1.);}
          vec3 p=vec3(q.x,0.,q.y)+d, area=cross(tz,tx),N=normalize(area);
          if(N.y<0.)N=-N;
          vec3 ray=refract(-uSun,N,1./1.333);
          vec3 flatRay=refract(-uSun,vec3(0.,1.,0.),1./1.333);
          vec3 hit=receiver(p,ray);
          vReference=receiver(vec3(q.x,0.,q.y),flatRay).xz;
          float flatTransmission=1.-dielectric(uSun.y,1.,1.333);
          float transmission=1.-dielectric(dot(N,uSun),1.,1.333);
          vFlux=max(0.,dot(area,uSun))/max(.03,uSun.y)*transmission/max(.001,flatTransmission);
          if(uSun.y<=0.||p.y<bedHeight(p.xz)||ray.y>=-.02)vFlux=0.;
          gl_Position=vec4(hit.x/uCausticSize*2.,hit.z/uCausticSize*2.,0.,1.);
        }`,
      fragmentShader:`precision highp float;
        in vec2 vReference;in float vFlux;out vec4 fragColor;
        uniform float uCausticSize,uCausticResolution;
        void main(){
          vec2 dx=dFdx(vReference),dy=dFdy(vReference);
          float pixelArea=pow(uCausticSize/uCausticResolution,2.);
          float density=abs(dx.x*dy.y-dx.y*dy.x)/pixelArea;
          // Bound unresolved singular folds before footprint integration.
          float energy=min(32.,max(0.,density*vFlux));
          fragColor=vec4(energy,0.,0.,1.);
        }`
    });
    this.scene=new THREE.Scene();
    this.mesh=new THREE.Mesh(geo,this.material);this.mesh.frustumCulled=false;
    this.scene.add(this.mesh);this.camera=new THREE.Camera();
    this.filter=new Pass(`precision highp float;in vec2 vUv;out vec4 fragColor;
      uniform highp sampler2D uSource;uniform vec2 uAxis;
      void main(){
        vec4 c=texture(uSource,vUv)*.227027027;
        c+=(texture(uSource,vUv+uAxis*1.384615385)+texture(uSource,vUv-uAxis*1.384615385))*.316216216;
        c+=(texture(uSource,vUv+uAxis*3.230769231)+texture(uSource,vUv-uAxis*3.230769231))*.070270270;
        fragColor=vec4(c.r,0.,0.,1.);
      }`,{uSource:U(null),uAxis:U(new THREE.Vector2())});
  }
  render(){
    const r=this.renderer;r.setRenderTarget(this.raw);r.setClearColor(0,0);r.clear();
    r.render(this.scene,this.camera);
    this.filter.uniforms.uSource.value=this.raw.texture;
    this.filter.uniforms.uAxis.value.set(1/this.resolution,0);this.filter.run(r,this.temp);
    this.filter.uniforms.uSource.value=this.temp.texture;
    this.filter.uniforms.uAxis.value.set(0,1/this.resolution);this.filter.run(r,this.target);
    r.setRenderTarget(null);
  }
  readMap(){
    const values=new Uint16Array(this.resolution*this.resolution*4);
    this.renderer.readRenderTargetPixels(this.target,0,0,this.resolution,this.resolution,values);
    const result=new Float32Array(this.resolution*this.resolution);
    for(let i=0;i<result.length;i++)result[i]=THREE.DataUtils.fromHalfFloat(values[i*4]);
    return result;
  }
  diagnostics(){
    return {method:'continuous refracted-ray mesh with area Jacobian',
      sourceGrid:this.n,atlas:this.resolution,sourceCellMetres:this.sourceSize/this.n,
      footprintFilter:'unit-sum separable reconstruction and mipmapped receiver lookup',
      geometry:'analytic bed receiver; projected caustics on other geometry remain approximate'};
  }
  dispose(){for(const rt of [this.raw,this.temp,this.target])rt.dispose();this.mesh.geometry.dispose();this.material.dispose();this.filter.dispose();}
}


return {Caustics};
})();
__M["src/post.js"]=(()=>{

const { THREE, Pass, target, uniform:U }=__M["src/gpu.js"];
const { environmentGLSL }=__M["src/environment.js"];
class PostProcessor {
  constructor(renderer, shared, width, height) {
    this.renderer = renderer;
    this.a = target(width, height, { type: THREE.HalfFloatType, linear: true });
    this.b = target(width, height, { type: THREE.HalfFloatType, linear: true });
    this.overlay = target(width,height,{type:THREE.HalfFloatType,linear:true});
    this.overlayCopy = new Pass(`precision highp float;in vec2 vUv;out vec4 fragColor;uniform highp sampler2D uInput;void main(){fragColor=texture(uInput,vUv);}`,{uInput:U(null)});
    this.valid = false;
    this.uniforms = {
      ...shared,
      uCurrent: U(null),
      uMotion: U(null),
      uDepth: U(null),
      uHistory: U(this.a.texture),
      uInvVP: U(new THREE.Matrix4()),
      uPrevVP: U(new THREE.Matrix4()),
      uPrevEye: U(new THREE.Vector3()),
      uResolution: U(new THREE.Vector2(width, height)),
      uHistoryValid: U(0),
      uUnderwater: U(0),
      uTAA: U(1),
      uDt: U(1 / 24),
    };
    this.resolve = new Pass(
      `precision highp float;in vec2 vUv;out vec4 fragColor;${environmentGLSL}
   uniform highp sampler2D uCurrent,uMotion,uDepth,uHistory;uniform mat4 uInvVP,uPrevVP;uniform vec2 uResolution;uniform float uHistoryValid,uUnderwater,uTAA,uDt;uniform vec3 uPrevEye;uniform vec4 uEyeSurface;
   vec3 world(vec2 uv,float d){vec4 p=uInvVP*vec4(uv*2.-1.,d*2.-1.,1.);return p.xyz/p.w;}
   vec3 volumeColor(vec2 uv){
    vec3 c=texture(uCurrent,uv).rgb;float depth=texture(uDepth,uv).r;
    vec3 p=world(uv,depth),ray=normalize(p-uEye);float len=min(160.,length(p-uEye));
    float eyeDistance=uEyeSurface.y*(uEye.y-uEyeSurface.w),endDistance=dot(uEyeSurface.xyz,p-vec3(uEye.x,uEyeSurface.w,uEye.z));
    float material=texture(uCurrent,uv).a,waterLength=uUnderwater*len;
    // Close the local near-clip gap while the camera crosses the interface.
    if(abs(eyeDistance)<.15&&material<.75){
      if(eyeDistance>=0.&&endDistance<0.)waterLength=len*(-endDistance)/max(.00001,eyeDistance-endDistance);
      else if(eyeDistance<0.&&endDistance>0.)waterLength=len*(-eyeDistance)/max(.00001,endDistance-eyeDistance);
    }
    if(waterLength>0.)c=c*transmittance(waterLength)+waterInscatter(ray,waterLength);
    return c;
   }
   void main(){float depth=texture(uDepth,vUv).r;vec3 p=world(vUv,depth);vec4 motion=texture(uMotion,vUv);vec3 previousPosition=p-motion.xyz*uDt*motion.a;vec4 prev=uPrevVP*vec4(previousPosition,1.);vec2 uv=prev.xy/prev.w*.5+.5;
    vec3 current=volumeColor(vUv),lo=current,hi=current;vec2 px=1./uResolution;for(int i=0;i<4;i++){vec2 off=i==0?vec2(px.x,0.):(i==1?vec2(-px.x,0.):(i==2?vec2(0.,px.y):vec2(0.,-px.y)));vec3 c=volumeColor(clamp(vUv+off,vec2(0.),vec2(1.)));lo=min(lo,c);hi=max(hi,c);}
    vec4 history=texture(uHistory,clamp(uv,.001,.999));float valid=uHistoryValid*uTAA;float material=texture(uCurrent,vUv).a;if(material>.05&&material<.95)valid=0.;
    if(prev.w<=0.||any(lessThan(uv,vec2(.001)))||any(greaterThan(uv,vec2(.999))))valid=0.;
    float z=length(p-uEye);float tolerance=.08+z*.025;if(abs(history.a-length(previousPosition-uPrevEye))>tolerance)valid=0.;
    vec3 clamped=clamp(history.rgb,lo-.008,hi+.008);float lumDelta=length(clamped-current)/(length(current)+.05);float weight=valid*.82*exp(-lumDelta*2.);
    fragColor=vec4(mix(current,clamped,weight),min(z,60000.));
   }`,
      this.uniforms,
    );
    this.display = new Pass(
      `precision highp float;in vec2 vUv;out vec4 fragColor;uniform highp sampler2D uInput;uniform float uExposure;uniform vec2 uResolution;
   float hash(vec2 p){return fract(sin(dot(p,vec2(127.1,311.7)))*43758.5453);}
   void main(){vec3 c=max(texture(uInput,vUv).rgb*uExposure,0.);c=clamp((c*(2.51*c+.03))/(c*(2.43*c+.59)+.14),0.,1.);c=mix(c*12.92,1.055*pow(c,vec3(1./2.4))-.055,greaterThan(c,vec3(.0031308)));float vig=1.-.065*pow(length((vUv-.5)*vec2(1.1,1.)),1.5);c=c*vig+(hash(gl_FragCoord.xy)-.5)/1024.;fragColor=vec4(c,1.);}`,
      {
        uInput: U(this.b.texture),
        uExposure: shared.uExposure,
        uResolution: this.uniforms.uResolution,
      },
    );
  }
  reset() {
    this.valid = false;
  }
  resize(w, h) {
    this.a.setSize(w, h);
    this.b.setSize(w, h);this.overlay.setSize(w,h);
    this.uniforms.uResolution.value.set(w, h);
    this.reset();
  }
  render(sceneRT, viewProjection, underwater, time,drawOverlay=null) {
    const u = this.uniforms;
    u.uCurrent.value = sceneRT.texture;
    u.uMotion.value = sceneRT.textures[1];
    u.uDt.value =
      this.lastTime === undefined ? 0 : Math.max(0, time - this.lastTime);
    this.lastTime = time;
    u.uDepth.value = sceneRT.depthTexture;
    u.uHistory.value = this.a.texture;
    u.uInvVP.value.copy(viewProjection).invert();
    u.uHistoryValid.value = this.valid ? 1 : 0;
    u.uUnderwater.value = underwater;
    this.resolve.run(this.renderer, this.b);
    if(drawOverlay){this.overlayCopy.uniforms.uInput.value=this.b.texture;this.overlayCopy.run(this.renderer,this.overlay);drawOverlay();}
    this.display.uniforms.uInput.value = drawOverlay?this.overlay.texture:this.b.texture;
    this.display.run(this.renderer, null);
    [this.a, this.b] = [this.b, this.a];
    u.uPrevVP.value.copy(viewProjection);
    u.uPrevEye.value.copy(u.uEye.value);
    this.valid = true;
  }
}



return {PostProcessor};
})();
__M["src/dynamics.js"]=(()=>{

const { THREE }=__M["src/gpu.js"];
const { clamp, mulberry32 }=__M["src/math.js"];
/** Rigid-body heave, surge, sway, pitch, roll and yaw. Buoyancy is evaluated at
 * distributed bottom probes; drag uses velocity relative to the local wave flow.
 * Equal-opposite horizontal impulses are returned to the depth-averaged patch.
 * Vertical wake forcing remains an explicit unresolved-flow approximation.
 */
// Closed-course guidance computes a heading, never a prescribed body position.
// It keeps the demonstration hull in the persistent 128 m interaction domain.
function courseHeading(x,z) {
  const a=28,b=11,centerZ=16;
  const theta=Math.atan2((z-centerZ)/b,x/a);
  const look=theta+.28;
  return Math.atan2(-(centerZ+b*Math.sin(look)-z),a*Math.cos(look)-x);
}
function eulerAngularAcceleration(omega,torque,inertia) {
  const angularMomentum=omega.clone().multiply(inertia);
  return torque.clone().sub(omega.clone().cross(angularMomentum)).divide(inertia);
}
class FloatingBody {
  constructor(
    model,
    {
      mass = 1550,
      length = 7,
      width = 2,
      height = 0.9,
      boat = false,
      position = [-16, 0.2, 4],
      velocity = [0, 0, 0],
    } = {},
  ) {
    this.model = model;
    this.mass = mass;
    this.length = length;
    this.width = width;
    this.height = height;
    this.boat = boat;
    this.position = new THREE.Vector3(...position);
    this.velocity = new THREE.Vector3(...velocity);
    this.quaternion = new THREE.Quaternion();
    this.omega = new THREE.Vector3();
    this.inertia = new THREE.Vector3(
      (mass * (height * height + width * width)) / 12,
      (mass * (length * length + width * width)) / 12,
      (mass * (height * height + length * length)) / 12,
    );
    this.points = [];
    for (let x = 0; x < 4; x++)
      for (let z = 0; z < 2; z++)
        this.points.push(
          new THREE.Vector3(
            (x / 3 - 0.5) * length * 0.7,
            -height * 0.43,
            (z - 0.5) * width * 0.64,
          ),
        );
    this.area = (length * width * 0.64) / this.points.length;
    this.forceHistory = [];
    this.wetVolume = 0;
    this.reactionImpulse = [0, 0];
  }
  probes() {
    return this.points.map((p) =>
      p.clone().applyQuaternion(this.quaternion).add(this.position),
    );
  }
  step(dt, samples, patch, time) {
    const force = new THREE.Vector3(0, -this.mass * 9.81, 0),
      torque = new THREE.Vector3();
    this.wetVolume = 0;
    this.reactionImpulse = [0, 0];
    this.points.forEach((local, i) => {
      const arm = local.clone().applyQuaternion(this.quaternion),
        point = arm.clone().add(this.position),
        s = samples[i];
      const depth = clamp(s.height - point.y, 0, this.height),
        volume = depth * this.area;
      this.wetVolume += volume;
      const hydro = new THREE.Vector3(0, 1025 * 9.81 * volume, 0);
      const relative = this.omega
        .clone()
        .cross(arm)
        .add(this.velocity)
        .sub(new THREE.Vector3(...s.velocity));
      const drag = relative
        .clone()
        .multiplyScalar(
          -0.52 *
            1025 *
            this.area *
            (depth / this.height) *
            Math.max(0.25, relative.length()),
        );
      if (this.boat) {
        const localDrag = drag
          .clone()
          .applyQuaternion(this.quaternion.clone().invert());
        localDrag.x *= 0.22;
        localDrag.z *= 0.7;
        drag.copy(localDrag.applyQuaternion(this.quaternion));
      }
      const maxDrag = (this.mass * 12) / this.points.length;
      if (drag.length() > maxDrag) drag.setLength(maxDrag);
      const f = hydro.add(drag);
      force.add(f);
      torque.add(arm.clone().cross(f));
      const impulse = [-f.x * dt, -f.z * dt];
      this.reactionImpulse[0] += impulse[0];
      this.reactionImpulse[1] += impulse[1];
      if (depth > 0) patch.impulse(point.x, point.z, 0, 0.62, 0, impulse);
    });
    if (this.boat) {
      const forward = new THREE.Vector3(1, 0, 0).applyQuaternion(
        this.quaternion,
      );
      const speed = forward.dot(this.velocity);
      const immersed=clamp(this.wetVolume/(this.mass/1025),0,1);
      const thrust = immersed*clamp(1000 + (4.5 - speed) * 1400, -1800, 4800);
      force.addScaledVector(forward, thrust);
      const desired = courseHeading(this.position.x,this.position.z),
        current = Math.atan2(-forward.z, forward.x);
      let error = desired - current;
      error = Math.atan2(Math.sin(error), Math.cos(error));
      torque.y += error * 8500 - this.omega.y * 6500;
      const stern = new THREE.Vector3(-this.length * 0.43, -0.1, 0)
        .applyQuaternion(this.quaternion)
        .add(this.position);
      const bow = new THREE.Vector3(this.length * 0.35, -0.1, 0)
        .applyQuaternion(this.quaternion)
        .add(this.position);
      // Motor momentum is returned as a submerged stern jet, not created freely.
      const motorImpulse=[-forward.x*thrust*dt,-forward.z*thrust*dt];
      patch.impulse(stern.x,stern.z,0,.78,0,motorImpulse);
      this.reactionImpulse[0]+=motorImpulse[0];this.reactionImpulse[1]+=motorImpulse[1];
      const factor = clamp(Math.abs(speed) / 5, 0, 1.7);
      patch.impulse(
        stern.x,
        stern.z,
        -0.014 * factor,
        0.72,
        1.4 * factor * dt,
        [0, 0],
      );
      patch.impulse(
        bow.x,
        bow.z,
        0.014 * factor,
        0.82,
        0.025 * factor * dt,
        [0, 0],
      );
      // Turbulent stern wake, transported by the same persistent patch rather than a painted decal.
      for (const side of [-1, 1]) {
        const sidePoint = new THREE.Vector3(-3.2, 0, side * 0.82)
          .applyQuaternion(this.quaternion)
          .add(this.position);
        patch.impulse(
          sidePoint.x,
          sidePoint.z,
          0.004 * factor,
          0.42,
          2.4 * factor * dt,
        );
      }
    }
    torque.addScaledVector(this.omega, -this.mass * 0.7);
    this.velocity.addScaledVector(force, dt / this.mass);
    this.position.addScaledVector(this.velocity, dt);
    const inv = this.quaternion.clone().invert(),
      localTorque = torque.clone().applyQuaternion(inv);
    localTorque.copy(eulerAngularAcceleration(this.omega.clone().applyQuaternion(inv),localTorque,this.inertia));
    this.omega.addScaledVector(
      localTorque.applyQuaternion(this.quaternion),
      dt,
    );
    const angularSpeed = this.omega.length();
    if (angularSpeed > 4) this.omega.setLength(4);
    if (angularSpeed > 1e-8) {
      const dq = new THREE.Quaternion().setFromAxisAngle(
        this.omega.clone().normalize(),
        this.omega.length() * dt,
      );
      this.quaternion.premultiply(dq).normalize();
    }
    this.model.position.copy(this.position);
    this.model.quaternion.copy(this.quaternion);
    this.model.updateMatrixWorld(true);
    return {
      position: this.position.toArray(),
      velocity: this.velocity.toArray(),
      angularVelocity: this.omega.toArray(),
      wetVolume: this.wetVolume,
      horizontalReactionImpulse: this.reactionImpulse,
    };
  }
}
class Dynamics {
  constructor(world) {
    this.world = world;
    this.bodies = [];
    this.rng = mulberry32(314159);
    this.probeCounter = 0;
  }
  reset(preset) {
    this.rng = mulberry32(314159);
    this.bodies = [];
    this.lastReports = [];
    if (preset.boat)
      this.bodies.push(
        new FloatingBody(this.world.boat, {
          boat: true,
          position: [-17, 0.2, 5],
          velocity: [3.8, 0, 0],
        }),
      );
    if (preset.buoys) {
      this.bodies.push(
        new FloatingBody(this.world.buoyModels[0], {
          mass: 610,
          length: 1.8,
          width: 1.8,
          height: 0.8,
          position: [-4, 0.05, -5],
        }),
      );
      this.bodies.push(
        new FloatingBody(this.world.buoyModels[1], {
          mass: 240,
          length: 1.6,
          width: 1.5,
          height: 0.45,
          position: [1.3, 0.02, -3],
        }),
      );
      this.bodies.push(
        new FloatingBody(this.world.buoyModels[2], {
          mass: 260,
          length: 1.3,
          width: 1.3,
          height: 0.65,
          position: [5.5, 0, -7],
        }),
      );
    }
    for (const b of this.bodies) {
      b.model.position.copy(b.position);
      b.model.quaternion.copy(b.quaternion);
      b.model.updateMatrixWorld(true);
    }
  }
  sampleAndStep(dt, time, ocean, patch, particles, preset) {
    const positions = [],
      ranges = [];
    for (const b of this.bodies) {
      ranges.push(positions.length);
      positions.push(...b.probes().map((v) => [v.x, v.z]));
    }
    const emitStart = positions.length;
    const count = preset.wind > 7 ? 48 : 0;
    for (let i = 0; i < count; i++)
      positions.push([(this.rng() - 0.5) * 108, (this.rng() - 0.5) * 108]);
    if (!positions.length) return;
    const samples = ocean.query(positions, patch.texture, patch.size);
    this.lastReports = [];
    for (let b = 0; b < this.bodies.length; b++) {
      const body = this.bodies[b];
      this.lastReports.push(
        body.step(
          dt,
          samples.slice(ranges[b], ranges[b] + body.points.length),
          patch,
          time,
        ),
      );
    }
    for (let i = emitStart; i < samples.length; i++) {
      const s = samples[i];
      if (
        s.height>preset.hs*.12 && s.velocity[1]>-.25 &&
        s.jacobian < preset.foamThreshold &&
        this.rng() < clamp((preset.foamThreshold - s.jacobian) * 3, 0, 1)
      ) {
        const p = positions[i];
        const count = 2 + Math.floor(this.rng() * 3);
        for (let j = 0; j < count; j++)
          particles.emitSpray(
            [
              p[0] + (this.rng() - 0.5) * 0.6,
              s.height + 0.025,
              p[1] + (this.rng() - 0.5) * 0.6,
            ],
            s.velocity,
            s.normal,
            preset.wind,
            s.jacobian,
          );
      }
    }
    if (preset.boat) {
      const b = this.bodies[0],
        stern = new THREE.Vector3(-3.5, -0.03, 0)
          .applyQuaternion(b.quaternion)
          .add(b.position);
      if (this.rng() < 0.75)
        for (let i = 0; i < 3; i++) {
          const side = this.rng() - 0.5,
            p = stern
              .clone()
              .add(
                new THREE.Vector3(
                  (this.rng() - 0.5) * 0.45,
                  0.02,
                  side * 1.7,
                ).applyQuaternion(b.quaternion),
              );
          particles.emitWake(p.toArray(), b.velocity.toArray(), side);
        }
    }
  }
}



return {courseHeading,eulerAngularAcceleration,FloatingBody,Dynamics};
})();
__M["src/rain-ripples.js"]=(()=>{

const { THREE, target, uniform:U }=__M["src/gpu.js"];
/** A resolved optical band for sub-grid rain rings. Birth positions come from
 * falling-drop contacts; the packet obeys gravity-capillary dispersion. It is
 * superposed on the coarse interaction solver, not a multiphase impact solve. */
class RainRipples {
  constructor(renderer, n = 1024, size = 48, max = 4096) {
    this.renderer = renderer;
    this.size = size;
    this.max = max;
    this.time = 0;
    this.events = [];
    this.target = target(n, n, { type: THREE.HalfFloatType, linear: true });
    this.positions = new Float32Array(max * 3);
    this.ages = new Float32Array(max);
    const g = (this.geometry = new THREE.BufferGeometry());
    g.setAttribute(
      "position",
      new THREE.BufferAttribute(this.positions, 3).setUsage(
        THREE.DynamicDrawUsage,
      ),
    );
    g.setAttribute(
      "aAge",
      new THREE.BufferAttribute(this.ages, 1).setUsage(THREE.DynamicDrawUsage),
    );
    this.material = new THREE.RawShaderMaterial({
      glslVersion: THREE.GLSL3,
      uniforms: { uN: U(n), uSize: U(size) },
      depthTest: false,
      depthWrite: false,
      transparent: true,
      blending: THREE.CustomBlending,
      blendSrc: THREE.OneFactor,
      blendDst: THREE.OneFactor,
      blendEquation: THREE.AddEquation,
      blendSrcAlpha: THREE.OneFactor,
      blendDstAlpha: THREE.OneFactor,
      vertexShader: `precision highp float;in vec3 position;in float aAge;uniform float uN,uSize;out float vAge,vRadius;void main(){vAge=aAge;vRadius=.34*aAge+.28;gl_PointSize=vRadius*2.*uN/uSize;gl_Position=vec4(position.xz/uSize*2.,0.,1.);}`,
      fragmentShader: `precision highp float;in float vAge,vRadius;out vec4 fragColor;void main(){vec2 p=(gl_PointCoord-.5)*2.*vRadius;p.y=-p.y;float r=length(p),k=28.55993321,w=sqrt(9.81*k+.000074*k*k*k),cg=(9.81+3.*.000074*k*k)/(2.*w),q=r-cg*vAge;float e=exp(-q*q/.009)*exp(-vAge*1.8)/sqrt(1.+12.*r);float phase=k*r-w*vAge,A=.0034*(1.-exp(-vAge*35.));float h=A*e*sin(phase),s=A*e*(k*cos(phase)+sin(phase)*(-2.*q/.009-6./(1.+12.*r)));fragColor=vec4(s*p/max(.01,r),h,0.);}`,
    });
    this.scene = new THREE.Scene();
    const points = new THREE.Points(g, this.material);
    points.frustumCulled = false;
    this.scene.add(points);
    this.camera = new THREE.Camera();
    this.reset();
  }
  reset() {
    this.events = [];
    this.time = 0;
    this.renderer.setRenderTarget(this.target);
    this.renderer.setClearColor(0, 0);
    this.renderer.clear();
    this.renderer.setRenderTarget(null);
  }
  birth(x, z, time) {
    if (Math.max(Math.abs(x), Math.abs(z)) < this.size * 0.45)
      this.events.push({ x, z, time });
  }
  render(time) {
    this.time = time;
    this.events = this.events
      .filter((e) => time - e.time < 2.4)
      .slice(-this.max);
    this.events.forEach((e, i) => {
      this.positions.set([e.x, 0, e.z], i * 3);
      this.ages[i] = time - e.time;
    });
    this.geometry.attributes.position.needsUpdate = true;
    this.geometry.attributes.aAge.needsUpdate = true;
    this.geometry.setDrawRange(0, this.events.length);
    this.renderer.setRenderTarget(this.target);
    this.renderer.setClearColor(0, 0);
    this.renderer.clear();
    if (this.events.length) this.renderer.render(this.scene, this.camera);
    this.renderer.setRenderTarget(null);
  }
}



return {RainRipples};
})();
__M["src/particles.js"]=(()=>{

const { THREE, uniform:U }=__M["src/gpu.js"];
const { environmentGLSL }=__M["src/environment.js"];
const { mulberry32, clamp }=__M["src/math.js"];
const overlayGLSL=`
uniform highp sampler2D uOpaqueDepth;uniform vec2 uOverlayResolution;uniform mat4 uOverlayInvVP;
uniform vec4 uEyeSurface;
float overlayVisibility(float size){
 vec2 uv=gl_FragCoord.xy/uOverlayResolution;float opaque=texture(uOpaqueDepth,uv).r;
 if(gl_FragCoord.z>opaque+.00000005)return 0.;
 vec4 p=uOverlayInvVP*vec4(uv*2.-1.,opaque*2.-1.,1.);p/=p.w;
 return smoothstep(0.,max(.025,size),length(p.xyz-uEye)-length(vWorld-uEye));
}
vec3 overlayExtinction(vec3 color){
 vec3 ray=vWorld-uEye;float len=length(ray);ray/=max(.001,len);
 float a=uEyeSurface.y*(uEye.y-uEyeSurface.w),b=dot(uEyeSurface.xyz,vWorld-vec3(uEye.x,uEyeSurface.w,uEye.z));
 float fraction=a<0.?1.:0.;
 if(a*b<0.)fraction=a<0.?(-a)/(b-a):(-b)/(a-b);
 if(a>=0.&&b>=0.)fraction=0.;
 float path=len*fraction;return color*transmittance(path)+waterInscatter(ray,path);
}`;
/** Seeded Lagrangian secondary particles with gravity, air drag and a bubble state.
 * Birth and re-entry are unresolved whitewater closures, not entrained-air CFD.
 */
class SecondaryParticles {
  constructor(shared, max = 10000) {
    this.max = max;
    this.shared = shared;
    this.position = new Float32Array(max * 3);
    this.velocity = new Float32Array(max * 3);
    this.info = new Float32Array(max * 4);
    this.age = new Float32Array(max);
    this.life = new Float32Array(max);
    this.surface = new Float32Array(max);
    this.cursor = 0;
    this.rng = mulberry32(871243);
    this.counts = { spray: 0, bubbles: 0 };
    const g = (this.geometry = new THREE.BufferGeometry());
    g.setAttribute(
      "position",
      new THREE.BufferAttribute(this.position, 3).setUsage(
        THREE.DynamicDrawUsage,
      ),
    );
    g.setAttribute(
      "aInfo",
      new THREE.BufferAttribute(this.info, 4).setUsage(THREE.DynamicDrawUsage),
    );
    this.material = new THREE.RawShaderMaterial({
      glslVersion: THREE.GLSL3,
      uniforms: {
        ...shared,
        uPointScale: U(1080),
        uUnderwater: shared.uUnderwater,
      },
      transparent: true,
      depthTest: false,
      depthWrite: false,
      vertexShader: `precision highp float;in vec3 position;in vec4 aInfo;uniform mat4 projectionMatrix,modelViewMatrix,modelMatrix;uniform float uPointScale;out vec4 vInfo;out float vDistance;out vec3 vWorld;void main(){vWorld=(modelMatrix*vec4(position,1.)).xyz;vec4 p=modelViewMatrix*vec4(position,1.);gl_Position=projectionMatrix*p;gl_PointSize=clamp(aInfo.y*uPointScale/max(.2,-p.z),.8,36.);vInfo=aInfo;vDistance=-p.z;}`,
      fragmentShader: `precision highp float;in vec4 vInfo;in float vDistance;in vec3 vWorld;out vec4 fragColor;uniform float uUnderwater;${environmentGLSL}${overlayGLSL}
    void main(){vec2 p=(gl_PointCoord-.5)*2.;float r=length(p);if(r>1.||vInfo.x<.002)discard;bool bubble=vInfo.z>1.5;
     float a=bubble?(.09*exp(-r*r*5.)+.50*exp(-pow((r-.80)*14.,2.))):exp(-r*r*3.6);
     vec3 c=environment(vec3(0.,1.,0.))*.6+uSunColor*.15+vec3(.18,.2,.21);if(bubble){c=skyDiffuse(vec3(0.,1.,0.))*.65+uSunColor*.07;if(uUnderwater<.5)a*=.12;}
     float visible=overlayVisibility(vInfo.y*2.);if(visible<.001)discard;
     fragColor=vec4(overlayExtinction(c),a*vInfo.x*(bubble?.65:.55)*visible);}`,
    });
    this.mesh = new THREE.Points(g, this.material);
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = 5;
    this.scene = new THREE.Scene();
    this.scene.add(this.mesh);
  }
  reset() {
    this.life.fill(0);
    this.info.fill(0);
    this.age.fill(0);
    this.rng = mulberry32(871243);
    this.cursor = 0;
  }
  emitSpray(p, v, n, wind, jac) {
    const i = this.cursor++ % this.max,
      k = i * 3,
      q = i * 4;
    this.position.set(p, k);
    this.surface[i] = p[1];
    const strength = clamp(1 - jac, 0.1, 1.5);
    this.velocity.set(
      [
        v[0] + (this.rng() - 0.5) * 1.4,
        Math.max(.15,v[1]) + .35 + strength * 1.2 + this.rng() * .7,
        v[2] + (this.rng() - 0.5) * 1.4,
      ],
      k,
    );
    this.life[i] = .8 + this.rng() * 1.5;
    this.age[i] = 0;
    this.info.set([0, .008 + Math.pow(this.rng(),3)*.046, 1, wind], q);
  }
  emitWake(p, v, side) {
    const i = this.cursor++ % this.max,
      k = i * 3,
      q = i * 4;
    this.position.set(p, k);
    this.surface[i] = p[1];
    this.velocity.set(
      [
        v[0] * 0.2 + (this.rng() - 0.5) * 0.5,
        0.4 + this.rng() * 0.8,
        v[2] * 0.2 + side * 0.9,
      ],
      k,
    );
    this.life[i] = 0.5 + this.rng() * 0.6;
    this.age[i] = 0;
    this.info.set([0, 0.009 + this.rng() * 0.02, 1, 4], q);
  }
  emitBubble(p) {
    const i = this.cursor++ % this.max,
      k = i * 3,
      q = i * 4;
    this.position.set(p, k);
    this.surface[i] = 0;
    this.velocity.set(
      [
        (this.rng() - 0.5) * 0.1,
        0.23 + this.rng() * 0.22,
        (this.rng() - 0.5) * 0.1,
      ],
      k,
    );
    this.life[i] = 5 + this.rng() * 9;
    this.age[i] = 0;
    this.info.set([0, 0.016 + this.rng() * 0.025, 2, 0], q);
  }
  step(dt,time,preset,ocean,patch){
    this.counts={spray:0,bubbles:0};const candidates=[],ids=[];
    for(let i=0;i<this.max;i++){
      const q=i*4,k=i*3;this.age[i]+=dt;
      if(this.age[i]>=this.life[i]){this.info[q]=0;continue;}
      const type=this.info[q+2];
      if(type<1.5){
        const drag=.32;this.velocity[k]+=(Math.cos(preset.direction)*preset.wind*.2-this.velocity[k])*drag*dt;
        this.velocity[k+2]+=(Math.sin(preset.direction)*preset.wind*.2-this.velocity[k+2])*drag*dt;
        this.velocity[k+1]-=9.81*dt;
      }else {this.velocity[k+1]+=(.34-this.velocity[k+1])*1.8*dt;}
      for(let j=0;j<3;j++)this.position[k+j]+=this.velocity[k+j]*dt;
      // Contacts use the current displaced surface at the particle's NEW position,
      // not the height of the crest where it was born seconds earlier.
      if((type<1.5&&this.age[i]>.1&&this.velocity[k+1]<0&&this.position[k+1]<preset.hs*2+.8)||type>1.5){candidates.push([this.position[k],this.position[k+2]]);ids.push(i);}
    }
    const hits=candidates.length&&ocean?ocean.query(candidates,patch.texture,patch.size):[];
    for(let j=0;j<ids.length;j++){
      const i=ids[j],q=i*4,k=i*3,s=hits[j];if(!s)continue;
      const top=patch.topAt(this.position[k],this.position[k+2]),type=this.info[q+2];
      if(top>=s.height&&this.position[k+1]<=top){this.life[i]=0;this.info[q]=0;continue;}
      if(type<1.5&&this.position[k+1]<s.height-.01){
        if(i%4===0){this.info[q+2]=2;this.info[q+1]*=.65;this.position[k+1]=s.height-.035;this.velocity[k+1]=-.25;this.age[i]=0;this.life[i]=3+this.rng()*4;}
        else {this.life[i]=0;this.info[q]=0;}
      }else if(type>1.5){
        this.velocity[k]+=(s.velocity[0]*Math.exp(Math.min(0,this.position[k+1]-s.height)*.3)-this.velocity[k])*dt;
        this.velocity[k+2]+=(s.velocity[2]*Math.exp(Math.min(0,this.position[k+1]-s.height)*.3)-this.velocity[k+2])*dt;
        if(this.position[k+1]>s.height-.012){this.life[i]=0;this.info[q]=0;}
      }
    }
    for(let i=0;i<this.max;i++){
      if(this.age[i]>=this.life[i])continue;const q=i*4;
      this.info[q]=Math.min(1,this.age[i]/.12)*Math.min(1,(this.life[i]-this.age[i])/.5);
      this.counts[this.info[q+2]<1.5?'spray':'bubbles']++;
    }
    const tick=Math.round((time-57)*60);
    if(preset.bubbleEmitter&&tick%3===0){const p=preset.bubbleEmitter;this.emitBubble([p[0]+(this.rng()-.5)*.7,p[1],p[2]+(this.rng()-.5)*.7]);}
    this.geometry.attributes.position.needsUpdate=true;this.geometry.attributes.aInfo.needsUpdate=true;
  }

}
/** Actual falling line segments; surface contacts create impulses in the field.
 * Contact queries use the current displaced ocean surface and static obstacle height.
 */
class Rain {
  constructor(shared, max = 5500) {
    this.max = max;
    this.rng = mulberry32(861783);
    this.coords = new Float32Array(max * 3);
    this.velocity = new Float32Array(max * 3);
    this.vertices = new Float32Array(max * 6);
    this.impacts = 0;
    const g = (this.geometry = new THREE.BufferGeometry());
    g.setAttribute(
      "position",
      new THREE.BufferAttribute(this.vertices, 3).setUsage(
        THREE.DynamicDrawUsage,
      ),
    );
    this.material = new THREE.RawShaderMaterial({
      glslVersion: THREE.GLSL3,
      uniforms: { ...shared },
      transparent: true,
      depthWrite: false,
      depthTest: false,
      vertexShader: `precision highp float;in vec3 position;uniform mat4 projectionMatrix,modelViewMatrix,modelMatrix;out float vD;out vec3 vWorld;void main(){vWorld=(modelMatrix*vec4(position,1.)).xyz;vec4 p=modelViewMatrix*vec4(position,1.);gl_Position=projectionMatrix*p;vD=-p.z;}`,
      fragmentShader: `precision highp float;in float vD;in vec3 vWorld;out vec4 fragColor;${environmentGLSL}${overlayGLSL}void main(){float fade=exp(-max(0.,vD)*.017)*overlayVisibility(.025);if(fade<.001)discard;fragColor=vec4(overlayExtinction(vec3(.47,.59,.64)),.16*fade);}`,
    });
    this.mesh = new THREE.LineSegments(g, this.material);
    this.mesh.frustumCulled = false;
    this.scene = new THREE.Scene();
    this.scene.add(this.mesh);
    this.reset();
  }
  reset() {
    this.rng = mulberry32(861783);
    this.impacts = 0;
    for (let i = 0; i < this.max; i++) {
      this.coords.set(
        [(this.rng() - 0.5) * 46, this.rng() * 26, (this.rng() - 0.5) * 46],
        i * 3,
      );
      this.velocity.set([0.45, -7 - this.rng() * 3, -0.25], i * 3);
    }
    this.pack();
  }
  pack() {
    for (let i = 0; i < this.max; i++) {
      const k = i * 3,
        j = i * 6;
      this.vertices[j] = this.coords[k];
      this.vertices[j + 1] = this.coords[k + 1];
      this.vertices[j + 2] = this.coords[k + 2];
      this.vertices[j + 3] = this.coords[k] - this.velocity[k] * 0.02;
      this.vertices[j + 4] = this.coords[k + 1] - this.velocity[k + 1] * 0.02;
      this.vertices[j + 5] = this.coords[k + 2] - this.velocity[k + 2] * 0.02;
    }
    this.geometry.attributes.position.needsUpdate = true;
  }
  step(dt,patch,preset,rings,time,ocean){
    if(!preset.rain)return;const candidates=[],ids=[];const bound=preset.hs*2+.05;
    for(let i=0;i<this.max;i++){
      const k=i*3;for(let j=0;j<3;j++)this.coords[k+j]+=this.velocity[k+j]*dt;
      if(this.coords[k+1]<=Math.max(bound,patch.topAt(this.coords[k],this.coords[k+2]))){ids.push(i);candidates.push([this.coords[k],this.coords[k+2]]);}
    }
    const hits=candidates.length?ocean.query(candidates,patch.texture,patch.size):[];
    for(let j=0;j<ids.length;j++){
      const i=ids[j],k=i*3,s=hits[j],bed=patch.topAt(this.coords[k],this.coords[k+2]);
      const surface=Math.max(s.height,bed);if(this.coords[k+1]>surface)continue;
      if(s.height>bed+.02){
        patch.impulse(this.coords[k],this.coords[k+2],-.003,.32,0);
        rings?.birth(this.coords[k],this.coords[k+2],time);this.impacts++;
      }
      this.coords[k]=(this.rng()-.5)*46;this.coords[k+1]=22+this.rng()*4;this.coords[k+2]=(this.rng()-.5)*46;
    }
    this.pack();
  }
}



return {SecondaryParticles,Rain};
})();
__M["src/replay.js"]=(()=>{

/** Portable fixed-tick input journal. Replays are deterministic on the same
 * backend/settings; this is not a bitwise cross-GPU networking guarantee. */
class ReplayJournal {
  constructor(seed = 91317) {
    this.seed = seed;
    this.reset("lagoon");
  }
  reset(scene) {
    this.scene = scene;
    this.events = [];
    this.cursor = 0;
    this.sequence = 0;
  }
  enqueue(tick, type, payload) {
    if (!Number.isSafeInteger(tick) || tick < 0)
      throw new RangeError("A replay tick must be a nonnegative integer");
    if (!["impulse", "flag", "extinction"].includes(type))
      throw new TypeError("Unsupported replay event: " + type);
    const e = {
      tick,
      sequence: this.sequence++,
      type,
      payload: JSON.parse(JSON.stringify(payload)),
    };
    ReplayJournal.validateEvent(e);
    this.events.push(e);
    this.events.sort((a, b) => a.tick - b.tick || a.sequence - b.sequence);
    return e;
  }
  consume(tick, apply) {
    while (
      this.cursor < this.events.length &&
      this.events[this.cursor].tick <= tick
    )
      apply(this.events[this.cursor++]);
  }
  export() {
    return {
      format: "cybr-water-replay",
      version: 1,
      seed: this.seed,
      scene: this.scene,
      step: 1 / 60,
      events: JSON.parse(JSON.stringify(this.events)),
    };
  }
  load(doc) {
    if (
      doc?.format !== "cybr-water-replay" ||
      doc.version !== 1 ||
      doc.seed !== this.seed ||
      Math.abs(doc.step - 1 / 60) > 1e-12 ||
      !Array.isArray(doc.events) ||
      doc.events.length > 10000
    )
      throw new TypeError("Invalid or incompatible water replay");
    this.reset(doc.scene);
    for (const e of doc.events) {
      const added = this.enqueue(e.tick, e.type, e.payload);
      if (e.sequence !== undefined) {
        if (!Number.isSafeInteger(e.sequence) || e.sequence < 0)
          throw new TypeError("Invalid event sequence");
        added.sequence = e.sequence;
      }
    }
    if (new Set(this.events.map((e) => e.sequence)).size !== this.events.length)
      throw new TypeError("Duplicate replay sequence");
    this.events.sort((a, b) => a.tick - b.tick || a.sequence - b.sequence);
    this.sequence = 1 + Math.max(-1, ...this.events.map((e) => e.sequence));
    return this;
  }
  static validateEvent(e) {
    const p = e.payload;
    if (!p || typeof p !== "object")
      throw new TypeError("Event payload must be an object");
    if (e.type === "impulse") {
      for (const k of ["x", "z", "height", "radius", "foam"])
        if (!Number.isFinite(p[k])) throw new TypeError("Invalid impulse " + k);
      if (
        p.radius < 0.2 ||
        p.radius > 8 ||
        Math.abs(p.height) > 3 ||
        p.foam < 0 ||
        p.foam > 2
      )
        throw new RangeError("Impulse is outside supported bounds");
    }
    if (
      e.type === "flag" &&
      (!["foam", "spray", "rain", "caustics", "reflections", "taa"].includes(
        p.name,
      ) ||
        typeof p.value !== "boolean")
    )
      throw new TypeError("Invalid feature flag");
    if (
      e.type === "extinction" &&
      (!Number.isFinite(p.scale) || p.scale < 0.05 || p.scale > 8)
    )
      throw new RangeError("Invalid extinction scale");
  }
}



return {ReplayJournal};
})();
__M["src/config.js"]=(()=>{

const common = {
  hs: 0.5,
  period: 5.2,
  direction: -0.55,
  chop: 0.65,
  depth: 18,
  sky: "blue",
  exposure: 1.05,
  sun: [-0.3059247094681465, 0.7419804117208311, -0.5965527141497358],
  sunColor: [2.3, 2.25, 2.12],
  wind: 5,
  roughness: 0.053,
  absorption: [0.19, 0.047, 0.021],
  scattering: [0.009, 0.017, 0.021],
  waterLight: [0.065, 0.34, 0.41],
  foamThreshold: 0.46,
  foamGain: 1,
  foamLifetime: 9,
  bed: [5, 0.07, 0.035, 0],
  terrain: false,
  rain: 0,
  boat: false,
  buoys: false,
  underwater: false,
  caustics: false,
};
const PRESETS = {
  dawn: {
    ...common,
    name: "First light / ocean",
    description: "GPU FFT • exact spectral slopes • low-angle solar reflection",
    hs: 2.7,
    period: 8.2,
    chop: 0.63,
    depth: 180,
    sky: "dawn",
    sun: [-0.7215476372512444, 0.03527423889821395, -0.6914656428538574],
    sunColor: [2.1, 1.1, 0.46],
    wind: 8,
    roughness: 0.055,
    bed: [180, 0, 0, 0],
  },
  blue: {
    ...common,
    name: "Open ocean",
    description: "Three disjoint wave bands • directional wind sea",
    hs: 3.4,
    period: 7.4,
    chop: 0.65,
    depth: 90,
    wind: 11,
    roughness: 0.072,
    bed: [90, 0, 0, 0],
  },
  storm: {
    ...common,
    name: "Heavy weather",
    description: "Persistent crest foam • velocity-driven spray • wind drag",
    hs: 6.8,
    period: 9.4,
    chop: 0.53,
    depth: 300,
    sky: "storm",
    sun: [-0.6, 0.2, -0.77],
    sunColor: [0.7, 0.78, 0.85],
    wind: 19,
    roughness: 0.1,
    foamThreshold: 0.65,
    foamGain: 1.15,
    foamLifetime: 7,
    bed: [300, 0, 0, 0],
    exposure: 1.17,
  },
  swell: {
    ...common,
    name: "Long-period swell",
    description: "Gravity-wave dispersion • large-scale surface displacement",
    hs: 5.4,
    period: 12.3,
    depth: 180,
    chop: 0.64,
    wind: 10,
    sky: "dawn",
    sun: [-0.7215476372512444, 0.03527423889821395, -0.6914656428538574],
    sunColor: [2.1, 1.1, 0.46],
    bed: [180, 0, 0, 0],
  },
  lagoon: {
    ...common,
    name: "The rocky cove",
    description: "Geometry-aware transmission • refracted seafloor caustics",
    hs: 0.42,
    period: 4.7,
    depth: 12,
    terrain: true,
    caustics: true,
    bed: [4.6, 0.072, 0.022, 1],
    absorption: [0.16, 0.033, 0.015],
    scattering: [0.006, 0.013, 0.017],
    waterLight: [0.12, 0.51, 0.59],
    wind: 3,
    roughness: 0.042,
  },
  reef: {
    ...common,
    name: "Rock / water interface",
    description:
      "Wet shoreline • geometric intersections • depth-dependent extinction",
    hs: 1.15,
    period: 6.0,
    depth: 14,
    terrain: true,
    caustics: true,
    bed: [4.6, 0.072, 0.022, 1],
    wind: 7,
    foamThreshold: 0.7,
    foamGain: 0.9,
  },
  harbor: {
    ...common,
    name: "Under power",
    description:
      "Floating rigid hull • local wave response • persistent stern wake",
    hs: 0.45,
    period: 4.8,
    depth: 18,
    terrain: true,
    boat: true,
    caustics: true,
    bed: [6.5, 0.025, 0.005, 1],
    wind: 4,
  },
  buoy: {
    ...common,
    name: "Six degrees of freedom",
    description:
      "Distributed hydrostatics • relative-flow drag • angular response",
    hs: 1.4,
    period: 6.4,
    depth: 26,
    buoys: true,
    bed: [26, 0, 0, 0],
    wind: 8,
  },
  rain: {
    ...common,
    name: "Rain on the cove",
    description: "Seeded rainfall • impact impulses • interacting ripple field",
    hs: 0.13,
    period: 3.1,
    depth: 12,
    terrain: true,
    rain: 1,
    sky: "storm",
    sun: [-0.6, 0.2, -0.77],
    sunColor: [0.85, 0.95, 1.1],
    exposure: 1.2,
    bed: [4.6, 0.072, 0.022, 1],
    roughness: 0.04,
    wind: 3,
  },
  clear: {
    ...common,
    name: "Optics / clear water",
    description: "The same scene • low extinction • visible seafloor",
    hs: 0.27,
    period: 4.4,
    depth: 12,
    terrain: true,
    caustics: true,
    bed: [4.6, 0.072, 0.022, 1],
    absorption: [0.105, 0.022, 0.011],
    scattering: [0.003, 0.006, 0.009],
    waterLight: [0.1, 0.45, 0.51],
    wind: 2,
    roughness: 0.037,
  },
  turbid: {
    ...common,
    name: "Optics / suspended sediment",
    description: "The same scene • greater scattering • shorter visibility",
    hs: 0.27,
    period: 4.4,
    depth: 12,
    terrain: true,
    caustics: true,
    bed: [4.6, 0.072, 0.022, 1],
    absorption: [0.24, 0.13, 0.08],
    scattering: [0.085, 0.09, 0.081],
    waterLight: [0.2, 0.32, 0.27],
    wind: 2,
    roughness: 0.037,
  },
  glass: {
    ...common,
    name: "Capillary detail",
    description:
      "Calm sea • millimetric capillary normals • interface reflection",
    hs: 0.075,
    period: 2.2,
    depth: 10,
    terrain: true,
    caustics: true,
    bed: [3.5, 0.06, 0.01, 1],
    wind: 0.8,
    roughness: 0.028,
  },
};
const FIXED_DT = 1 / 60;
const SEED = 91317;

PRESETS.bubbles={...PRESETS.clear,name:"Bubble column / open water",description:"Secondary bubble transport • no emitter hidden inside a rock",bubbleEmitter:[0,-3.7,-2]};

PRESETS.silver = { ...PRESETS.blue, name:"Silver sea", description:"Oblique daylight / directional swells", hs:2.1, period:7.8, roughness:.065, wind:8 };
PRESETS.afterglow = { ...PRESETS.dawn, name:"Afterglow", description:"Long-period swell / warm low-angle sky", hs:1.15, period:8.8, roughness:.06, wind:4, exposure:1.16 };

// Rotate the entire measured environment: sun, reflection lookup and diffuse SH.
// The daylight cove is front-lit without introducing an unrelated fake fill light.
for (const key of ["lagoon","clear","turbid","reef","harbor","glass","bubbles"]) PRESETS[key].skyYaw=Math.PI;

// Foam is an unresolved visual closure, not resolved overturning surf.
Object.assign(PRESETS.storm,{foamThreshold:.91,foamGain:1.35,foamLifetime:8.5});
Object.assign(PRESETS.blue,{foamThreshold:.80,foamGain:.85});
Object.assign(PRESETS.silver,{foamThreshold:.80,foamGain:.85});



// Separate optics scenes use small, short-period waves; no caustic texture animation.
PRESETS.shallows = {...PRESETS.clear,name:'Sunlit shallows',
 description:'Continuous refracted caustics / sand, stone and moving light',
 hs:.25,period:1.85,chop:.50,depth:3.1,wind:2.4,roughness:.035,
 bed:[3.05,.024,.006,0],sunColor:[4.2,3.95,3.6],
 absorption:[.092,.021,.012],scattering:[.0025,.0045,.005],
 waterLight:[.07,.28,.32],exposure:1.12};
PRESETS.ripples = {...PRESETS.shallows,name:'Ripple interference',
 description:'Local impulses / overlapping waves / refracted light',
 hs:.045,period:1.7,wind:.7,roughness:.029};
PRESETS.bubbles = {...PRESETS.shallows,name:'Bubbles in sunlight',
 description:'Buoyant secondary particles / wavelength-dependent attenuation',
 hs:.18,period:1.9,bubbleEmitter:[1,-2.5,-2]};


// Energy-normalized crossing seas: amplitudes are NOT multiplied by arbitrary per-band gains.
function seaSystems(period,direction,windFraction=.075,crossFraction=.20){
 return [
  {period,direction,fraction:1-windFraction-crossFraction,gamma:4.2,spread:22},
  {period:period*1.37,direction:direction+.83,fraction:crossFraction,gamma:2.4,spread:12},
  {period:period*.43,direction:direction-.22,fraction:windFraction,gamma:1.3,spread:3}
 ];
}
Object.assign(PRESETS.blue,{name:'Atlantic / crossing seas',hs:4.8,period:9.2,chop:.72,roughness:.105,wind:12,foamThreshold:.65,foamGain:3.2,foamLifetime:12,waterLight:[.08,.32,.31],description:'Energy-balanced swell + crossing sea + short wind waves / persistent whitewater'});
Object.assign(PRESETS.storm,{name:'Gale / breaking crests',hs:8.2,period:10.8,chop:.52,roughness:.13,wind:23,foamThreshold:.69,foamGain:4.7,foamLifetime:16,exposure:1.08,waterLight:[.06,.22,.22],description:'Steeper multiscale crests / wind-driven spray / aged foam trails'});
Object.assign(PRESETS.swell,{name:'Ocean swell / long-period energy',hs:6.3,period:13.2,chop:.80,foamThreshold:.61,foamGain:2.8,foamLifetime:11});
Object.assign(PRESETS.dawn,{hs:3.7,period:9.4,chop:.74,foamThreshold:.64,foamGain:2.6,foamLifetime:11});
for(const k of ['blue','dawn','storm','swell','silver','afterglow']){
 const p=PRESETS[k];p.seaSystems=seaSystems(p.period,p.direction,k==='storm'?.12:k==='swell'?.025:.065,k==='swell'?.12:.20);
}
PRESETS.whitewater={...PRESETS.blue,name:'Whitewater / surface study',roughness:.11,hs:5.9,period:8.4,chop:.46,wind:17,foamThreshold:.72,foamGain:4.6,foamLifetime:17,seaSystems:seaSystems(8.4,-.55,.12,.14),description:'Fresh crest aeration → porous rafts → elongated residual foam'};

return {PRESETS,FIXED_DT,SEED};
})();
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