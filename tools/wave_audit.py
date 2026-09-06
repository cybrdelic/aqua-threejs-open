import json,numpy as np
from pathlib import Path
root=Path(__file__).resolve().parents[1]/'docs';configs=json.loads((root/'sea-systems.json').read_text());rng=np.random.default_rng(7713)
pts=rng.uniform(-384,384,(80000,2));result={}
for key,info in configs.items():
 n=info['n'];q=np.fft.fftfreq(n)*n;ix=(-np.arange(n))%n;results=[]
 for t in [57,61,66,73]:
  fields=[np.zeros(len(pts)) for _ in range(4)]
  for b,band in enumerate(info['band']):
   raw=np.fromfile(root/f'{key}-{b}.f32',np.float32).reshape(n,n,4);w=raw[:,:,2];h0=raw[:,:,0]+1j*raw[:,:,1]
   # Time convention matches reference: h0(k)e^-iwt + conj(h0(-k))e^+iwt.
   h=(h0*np.exp(-1j*w*t)+np.conj(h0[ix[:,None],ix[None,:]])*np.exp(1j*w*t))*(n*n)
   kx=q[None,:]*2*np.pi/band['length'];kz=q[:,None]*2*np.pi/band['length'];k=np.hypot(kx,kz);cp=info['preset']['chop']/np.maximum(k,1e-15)
   g=[h,-kx*kx*cp*h,-kx*kz*cp*h,-kz*kz*cp*h]
   uv=(pts/band['length']*n)%n;u=np.floor(uv).astype(int);f=uv-u
   for fnum,coef in enumerate(g):
    a=np.fft.ifft2(coef).real
    interp=(a[u[:,1],u[:,0]]*(1-f[:,0])+a[u[:,1],(u[:,0]+1)%n]*f[:,0])*(1-f[:,1])+(a[(u[:,1]+1)%n,u[:,0]]*(1-f[:,0])+a[(u[:,1]+1)%n,(u[:,0]+1)%n]*f[:,0])*f[:,1]
    fields[fnum]+=interp
  h,xx,xz,zz=fields;J=(1+xx)*(1+zz)-xz*xz;lam=.5*(2+xx+zz-np.sqrt((xx-zz)**2+4*xz*xz))
  results.append({'time':t,'heightMin':float(h.min()),'heightMax':float(h.max()),'sampledHs':float(h.std()*4),'minJacobian':float(J.min()),'foldFraction':float(np.mean(J<0)),'minEigenvalue':float(lam.min()),'compressionPercent':float(100*np.mean(J<info['preset']['foamThreshold']))})
 result[key]=results
print(json.dumps(result,indent=2));(root/'wave-audit.json').write_text(json.dumps(result,indent=2))
