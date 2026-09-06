__M["src/surface-shading.js"]=(()=>{

/** Shared surface-lighting evaluation used by primary raster visibility and by
 * traced reflection/refraction hits. No screen-colour lookup and no second,
 * incompatible material approximation for an off-screen object. */
const surfaceLightingGLSL = `
uniform highp sampler2D uRockDiffuse,uRockNormal,uSandDiffuse,uSandNormal,uCaustics,uShadowDepth;
uniform mat4 uShadowMatrix;uniform float uCausticSize,uCausticEnable,uPixelFootprint;
vec3 srgbDecode(vec3 c){return mix(c/12.92,pow((c+.055)/1.055,vec3(2.4)),greaterThan(c,vec3(.04045)));}
float sunlightVisibility(vec3 p,vec3 n){
 vec4 sc=uShadowMatrix*vec4(p+n*.035,1.);vec3 q=sc.xyz/sc.w*.5+.5;
 if(any(lessThan(q,vec3(.001)))||any(greaterThan(q,vec3(.999))))return 1.;
 float visibility=0.;for(int i=0;i<4;i++){vec2 off=vec2((i%2)==0?-.6:.6,i<2?-.6:.6)/1536.;float depth=texture(uShadowDepth,q.xy+off).r;visibility+=q.z-(.00045+.001*(1.-max(0.,dot(n,uSun))))<depth?1.:0.;}return visibility*.25;
}
vec3 surfaceRadiance(vec3 p,vec3 geomNormal,vec3 view,vec3 base,float kind){
 vec3 N=normalize(geomNormal),albedo=base;float distanceToEye=length(p-uEye);
 // An explicit ray-cone footprint is valid inside divergent BVH hit branches;
 // implicit texture derivatives there are undefined on some GPU backends.
 float cone=max(.00001,distanceToEye*uPixelFootprint)/max(.2,abs(dot(N,view)));
 float rockLod=clamp(log2(cone*float(textureSize(uRockDiffuse,0).x)/2.4),0.,8.);
 float sandLod=clamp(log2(cone*float(textureSize(uSandDiffuse,0).x)*.5),0.,8.);
 if(kind<.5){
  vec2 uv=p.xz*.5;vec3 sandTex=srgbDecode(textureLod(uSandDiffuse,uv,sandLod).rgb);
  float sandLuma=dot(sandTex,vec3(.2126,.7152,.0722));
  // Mineral reflectance with restrained real texture variation.
  float dune=.94+.06*sin(p.x*.51+p.z*.34+sin(p.z*.16));
  albedo=vec3(.52,.46,.35)*clamp(.68+1.25*sandLuma,.65,1.15)*dune;
  vec3 map=textureLod(uSandNormal,uv,sandLod).xyz*2.-1.;N=normalize(N+vec3(map.x,0.,map.y)*.23);
 }else if(kind<1.5){
  vec3 weights=pow(abs(N),vec3(6.));weights/=max(.001,weights.x+weights.y+weights.z);
  vec3 ax=srgbDecode(textureLod(uRockDiffuse,p.yz/2.4,rockLod).rgb),ay=srgbDecode(textureLod(uRockDiffuse,p.zx/2.4,rockLod).rgb),az=srgbDecode(textureLod(uRockDiffuse,p.xy/2.4,rockLod).rgb);
  vec3 rockTex=ax*weights.x+ay*weights.y+az*weights.z;
  float rockLuma=dot(rockTex,vec3(.2126,.7152,.0722));
  albedo=mix(rockTex,vec3(rockLuma),.62)*1.2+vec3(.042,.046,.047);
  float strata=.90+.1*smoothstep(-.5,.65,sin(p.y*3.8+p.x*.18+p.z*.27));
  albedo*=strata;
  // Reoriented surface-gradient detail, with a handed basis on each projection.
  vec3 bx=textureLod(uRockNormal,p.yz/2.4,rockLod).xyz*2.-1.,by=textureLod(uRockNormal,p.zx/2.4,rockLod).xyz*2.-1.,bz=textureLod(uRockNormal,p.xy/2.4,rockLod).xyz*2.-1.;
  vec3 gradient=vec3(0.,bx.x,bx.y)*weights.x+vec3(by.y,0.,by.x)*weights.y+vec3(bz.x,bz.y,0.)*weights.z;
  gradient-=N*dot(gradient,N);N=normalize(N+gradient*.20);
 }else if(kind>2.5&&kind<3.5){albedo*=.7+.22*noise2(p.xz*vec2(7.,.4));}
 float localSurface=displace(p.xz).y;
 float wet=1.-smoothstep(localSurface+.035,localSurface+.32,p.y);
 if(kind<1.5)albedo*=mix(1.,.66,wet);
 float depth=max(0.,localSurface-p.y);vec3 L;
 vec3 beam=directSolarTransfer(uSun,uAbsorption+uScattering,depth,depth>0.,solarVisibility(),L);
 vec3 shadowPoint=depth>0.?p+L*(depth/max(.001,L.y)):p;
 float shadow=sunlightVisibility(shadowPoint,N),nl=max(0.,dot(N,L));
 vec3 direct=uSunColor*beam*shadow;
 vec3 diffuse=skyDiffuse(N)*1.05+direct*nl/PI;
 if(depth>0.){
  vec2 cuv=p.xz/uCausticSize+.5;
  float focus=1.;
  if(uCausticEnable>.5){
   float edge=max(abs(cuv.x-.5),abs(cuv.y-.5));
   float atlasWeight=1.-smoothstep(.40,.48,edge);
   float focusLod=clamp(log2(max(1.,cone*float(textureSize(uCaustics,0).x)/uCausticSize)),0.,9.);
   float flux=clamp(textureLod(uCaustics,clamp(cuv,.001,.999),focusLod).r,.08,8.);
   focus=mix(1.,flux,atlasWeight);
  }
  // Caustics redistribute the direct term. They no longer add a second sun.
  diffuse=skyDiffuse(N)*.65*transmittance(depth*1.15)+direct*nl*mix(1.,focus,.82)/PI;
 }
 vec3 H=normalize(view+L);float nv=max(.001,dot(N,view));
 float rough=kind>3.5?.17:kind>1.5?.34:(kind<.5?.85:mix(.89,.51,wet));
 float a2=pow(rough,4.),nh=max(0.,dot(N,H)),den=nh*nh*(a2-1.)+1.;
 float D=a2/(PI*den*den),Gv=2.*nv/(nv+sqrt(a2+(1.-a2)*nv*nv)),Gl=2.*nl/(nl+sqrt(a2+(1.-a2)*nl*nl)+.0001);
 float F=.025+.975*pow(1.-max(0.,dot(view,H)),5.);
 // Both lobes receive the same occluded, refracted and attenuated beam.
 vec3 color=albedo*diffuse+direct*(D*Gv*Gl*F/max(.004,4.*nv));
 if(kind>3.5)color=mix(color,environmentRough(reflect(-view,N),rough)*albedo,.40);
 return max(color,vec3(0.));
}
`;



return {surfaceLightingGLSL};
})();
