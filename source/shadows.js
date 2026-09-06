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
