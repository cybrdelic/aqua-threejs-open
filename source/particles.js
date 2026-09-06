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
