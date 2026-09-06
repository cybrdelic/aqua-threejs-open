__M["src/interaction-kernel.js"]=(()=>{

/** Discrete, wet-cell-aware source normalization. Normalizing the actual stencil
 * removes the net water-volume injection of the old truncated Mexican hat. */
function normalizedSource(x,z,radius,n,size,bed,defaultDepth=1.1) {
  const dx=size/n,r=Math.max(radius,dx*.65),items=[];
  const clamp=(v)=>Math.max(0,Math.min(n-1,v));
  const loX=clamp(Math.ceil((x-3*r+size/2)/dx-.5)),hiX=clamp(Math.floor((x+3*r+size/2)/dx-.5));
  const loZ=clamp(Math.ceil((z-3*r+size/2)/dx-.5)),hiZ=clamp(Math.floor((z+3*r+size/2)/dx-.5));
  let gSum=0,lapSum=0,mx=0,mz=0;
  for(let j=loZ;j<=hiZ;j++)for(let i=loX;i<=hiX;i++) {
    const id=(j*n+i)*4,H=bed?bed[id]:defaultDepth;if(H<.02)continue;
    const px=((i+.5)*dx-size/2-x)/r,pz=((j+.5)*dx-size/2-z)/r,r2=px*px+pz*pz;
    if(r2>9)continue;const g=Math.exp(-.5*r2),l=(1-.5*r2)*g;
    gSum+=g;lapSum+=l;mx+=g*(bed?bed[id+1]:H);mz+=g*(bed?bed[id+2]:H);
    items.push({i,j,g,l,depth:H});
  }
  const mean=gSum?lapSum/gSum:0;
  return {radius:r,mean,momentumX:mx>0?1/(1025*dx*dx*mx):0,momentumZ:mz>0?1/(1025*dx*dx*mz):0,
    items:items.map(p=>({...p,heightWeight:p.l-mean*p.g})),accepted:gSum>0};
}



return {normalizedSource};
})();
