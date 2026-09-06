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
