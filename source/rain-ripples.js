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
