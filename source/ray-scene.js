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
