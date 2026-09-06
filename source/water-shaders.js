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
