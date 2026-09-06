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
