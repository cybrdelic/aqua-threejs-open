__M["src/light-transport.js"]=(()=>{

/** Flat-interface direct beam transport; RGB extinction in inverse metres.
 * The cosine ratio preserves transmitted power per horizontal interface area.
 * This does not replace caustic focusing or resolve curved-interface visibility.
 */
const directBeamGLSL = `
vec3 directSolarTransfer(vec3 sun,vec3 extinction,float depth,bool submerged,float cloud,out vec3 L){
 sun=normalize(sun);float mu=max(0.,sun.y);L=sun;
 if(mu<=0.)return vec3(0.);
 float visible=clamp(cloud,0.,1.);if(!submerged)return vec3(visible);
 float eta=1./1.333,cw=sqrt(max(0.,1.-eta*eta*(1.-mu*mu)));
 L=vec3(sun.x*eta,cw,sun.z*eta);
 float rs=(mu-1.333*cw)/(mu+1.333*cw),rp=(1.333*mu-cw)/(1.333*mu+cw),F=.5*(rs*rs+rp*rp);
 float beamPower=(1.-F)*mu/max(.00001,cw);
 return vec3(visible*beamPower)*exp(-max(extinction,vec3(0.))*max(0.,depth)/max(.00001,cw));
}
`;
function directSolarTransferJS(
  sun,
  extinction,
  depth,
  submerged,
  cloud = 1,
) {
  if (
    !sun.every(Number.isFinite) ||
    !extinction.every((v) => Number.isFinite(v) && v >= 0) ||
    !Number.isFinite(depth) ||
    !Number.isFinite(cloud)
  )
    throw new RangeError("Invalid beam inputs");
  const n = Math.hypot(...sun);
  if (n === 0) throw new RangeError("Zero light direction");
  const s = sun.map((v) => v / n),
    mu = Math.max(0, s[1]),
    visible = Math.max(0, Math.min(1, cloud));
  if (mu <= 0) return { direction: s, transfer: [0, 0, 0] };
  if (!submerged)
    return { direction: s, transfer: [visible, visible, visible] };
  const eta = 1 / 1.333,
    cw = Math.sqrt(1 - eta * eta * (1 - mu * mu));
  const rs = (mu - 1.333 * cw) / (mu + 1.333 * cw),
    rp = (1.333 * mu - cw) / (1.333 * mu + cw);
  const power = ((1 - (rs * rs + rp * rp) / 2) * mu) / cw;
  return {
    direction: [s[0] * eta, cw, s[2] * eta],
    transfer: extinction.map(
      (x) => visible * power * Math.exp((-x * Math.max(0, depth)) / cw),
    ),
  };
}



return {directBeamGLSL,directSolarTransferJS};
})();
