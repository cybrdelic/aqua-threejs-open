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
