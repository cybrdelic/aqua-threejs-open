'use strict';
const fs=require('node:fs'),vm=require('node:vm'),path=require('node:path'),assert=require('node:assert/strict');
const root=path.resolve(__dirname,'..');const ctx={console};vm.createContext(ctx);
vm.runInContext('const __M={};'+['math.js','fft.js','spectrum.js','config.js'].map(n=>fs.readFileSync(path.join(root,'source',n),'utf8')).join('\n')+';globalThis.M=__M;',ctx);
const {Spectrum}=ctx.M['src/spectrum.js'],{PRESETS}=ctx.M['src/config.js'];let count=0;
function test(name,f){f();console.log(`ok ${++count} - ${name}`);}
console.log('TAP version 13');
for(const k of ['blue','dawn','storm','swell','whitewater']){
 const p=PRESETS[k],s=new Spectrum(128,p,91317);
 test(k+' energy normalized',()=>{let v=0;for(const b of s.bands)for(let i=0;i<b.h0.length;i+=4)v+=2*(b.h0[i]**2+b.h0[i+1]**2);assert.ok(Math.abs(v-(p.hs/4)**2)<1e-6);});
 test(k+' system fractions sum to one',()=>assert.ok(Math.abs(s.systems.reduce((a,c)=>a+c.energyFraction,0)-1)<1e-12));
 test(k+' disjoint wave bands',()=>{for(const b of s.bands)for(let i=0;i<b.h0.length;i+=4){const l=2*Math.PI/(b.h0[i+3]||1e-30);if(l<b.minWave-1e-5||l>=b.maxWave+1e-5)assert.equal(b.h0[i]**2+b.h0[i+1]**2,0);}});
 test(k+' exact seeded reset',()=>{const t=new Spectrum(128,p,91317);for(let b=0;b<3;b++)assert.equal(Buffer.compare(Buffer.from(s.bands[b].h0.buffer),Buffer.from(t.bands[b].h0.buffer)),0);});
 test(k+' finite reference heights and velocities',()=>{const f=s.reference(64.75,0);for(const name of ['h','vy','hx','xx'])for(const v of f[name].r)assert.ok(Number.isFinite(v));});
}
test('zero wave height has zero spectral energy',()=>{const s=new Spectrum(32,{...PRESETS.blue,hs:0});for(const b of s.bands)for(let i=0;i<b.h0.length;i+=4)assert.equal(b.h0[i]**2+b.h0[i+1]**2,0);});
test('camera has no old 180 metre clamp',()=>assert.ok(!fs.readFileSync(path.join(root,'source/app.js'),'utf8').includes('5, 180')));
test('full-period foam uses wrapping, not an edge fade',()=>{const s=fs.readFileSync(path.join(root,'source/sim-fields.js'),'utf8').split('class WhitewaterField')[1];assert.ok(s.includes('THREE.RepeatWrapping'));assert.ok(!s.includes('smoothstep(0.,.02,edge)'));});
test('visible-crest normals use geometric correction, not a downward flip',()=>{const s=fs.readFileSync(path.join(root,'source/water-shaders.js'),'utf8');assert.ok(s.includes('dFdx(vWorld),dFdy(vWorld)'));assert.ok(s.includes('ngv-align'));assert.ok(!s.includes('if(dot(N,V)<0.)N=-N;'));});
test('zero-height whitewater avoids equal smoothstep endpoints',()=>assert.ok(fs.readFileSync(path.join(root,'source/sim-fields.js'),'utf8').includes('max(.001,uHs*.17)')));
const audit=JSON.parse(fs.readFileSync(path.join(root,'docs/wave-audit.json'),'utf8'));
for(const k of Object.keys(audit))test(k+' sampled film-time surface has positive horizontal Jacobian',()=>{for(const a of audit[k])assert.ok(a.minJacobian>0,JSON.stringify(a));});
console.log(`1..${count}`);console.log(`# ${count} checks passed`);
