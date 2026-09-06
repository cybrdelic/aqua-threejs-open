const fs=require('fs'),vm=require('vm'),path=require('path');
const root=path.resolve(__dirname,'..'),base=path.join(root,'source');
fs.mkdirSync(path.join(root,'docs'),{recursive:true});
let code='const __M={};\n'+['math.js','fft.js','spectrum.js','config.js'].map(n=>fs.readFileSync(path.join(base,n),'utf8')).join('\n');
code+='\nglobalThis.modules=__M;';
const ctx={console,Float32Array,Float64Array,Uint32Array,Uint16Array,Math};vm.createContext(ctx);vm.runInContext(code,ctx);
let out={};for(const k of ['dawn','blue','storm','swell','whitewater']){
 const p=ctx.modules['src/config.js'].PRESETS[k],n=256,sp=new ctx.modules['src/spectrum.js'].Spectrum(n,p);
 const band=[];for(let b=0;b<3;b++) {const dest=path.join(root,'docs',`${k}-${b}.f32`);fs.writeFileSync(dest,Buffer.from(sp.bands[b].h0.buffer));band.push({length:sp.bands[b].length,variance:sp.bands[b].variance});}
 out[k]={preset:p,expectedVariance:sp.expectedVariance,n,band,systems:sp.systems};
}
fs.writeFileSync(path.join(root,'docs/sea-systems.json'),JSON.stringify(out,null,2));
