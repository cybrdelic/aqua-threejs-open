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
