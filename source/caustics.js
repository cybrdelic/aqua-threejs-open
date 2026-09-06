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
