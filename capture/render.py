"""Capture actual native-1080p browser frames with deterministic fixed-step simulation.
All video frames are newly rendered. No interpolation, image generation or upscale.
"""
from pathlib import Path
from playwright.sync_api import sync_playwright
import os,json,time,subprocess,hashlib,math,sys,shutil
ROOT=Path(__file__).resolve().parents[1];OUT=ROOT/'capture/output';OUT.mkdir(parents=True,exist_ok=True)
SHOTS=[
 {'name':'01-first-light','scene':'dawn','title':'First light, crossing swell','caption':'Independent swell and wind-sea energy • resolved multiscale slopes','eye':[14,5.7,24],'end':[-2,6.2,17],'target':[-46,0,-68],'targetEnd':[-56,0,-66],'fov':54,'seconds':8},
 {'name':'02-crossing-seas','scene':'blue','title':'Swell meets wind sea','caption':'Three wave systems • 256² × 3 GPU FFT • finite-depth dispersion','eye':[-20,5.6,15],'end':[-7,5.9,11],'target':[45,0,-50],'targetEnd':[51,0,-55],'fov':54,'seconds':8},
 {'name':'03-whitewater','scene':'whitewater','title':'Whitewater, from above','caption':'Crest aeration • porous rafts • wind-stretched, aging foam','eye':[25,22,35],'end':[8,19,32],'target':[4,0,0],'targetEnd':[-8,0,-8],'fov':48,'seconds':8},
 {'name':'04-gale','scene':'storm','title':'Gale / crest-level tracking','caption':'Larger gravity waves • velocity-inheriting spray • persistent foam','eye':[-10,9.5,22],'end':[-25,10.5,10],'target':[70,0,-42],'targetEnd':[60,0,-60],'fov':56,'seconds':8},
 {'name':'05-zoom','scene':'whitewater','title':'Beyond the old zoom limit','caption':'Actual orbit dolly • adaptive clip planes • continuous ocean coverage','zoom':True,'seconds':10},
]
(OUT/'shots.json').write_text(json.dumps(SHOTS,indent=2))
html=(ROOT/'public/standalone.html').read_text();build_sha=hashlib.sha256(html.encode()).hexdigest();bundle_sha=hashlib.sha256((ROOT/'public/engine-bundle.js').read_bytes()).hexdigest()
errors=[];warnings=[];reports=[]
with sync_playwright() as pw:
 exe=os.getenv('CHROMIUM_EXECUTABLE') or shutil.which('chromium') or shutil.which('google-chrome')
 kw=dict(headless=True,args=['--no-sandbox','--disable-dev-shm-usage','--use-gl=angle','--use-angle=gl','--ignore-gpu-blocklist','--enable-unsafe-swiftshader'],env={**os.environ,'LIBGL_ALWAYS_SOFTWARE':'1','LP_NUM_THREADS':'4'})
 if exe:kw['executable_path']=exe
 browser=pw.chromium.launch(**kw);page=browser.new_page(viewport={'width':1920,'height':1080},device_scale_factor=1);page.set_default_timeout(240000)
 page.on('pageerror',lambda e:errors.append(str(e)))
 page.on('console',lambda m:errors.append(m.text) if m.type=='error' else (warnings.append(m.text) if m.type=='warning' else None))
 page.evaluate("window.__QUERY__='?capture=1&width=1920&height=1080&grid=256&scene=dawn'")
 page.set_content(html,wait_until='domcontentloaded',timeout=240000);page.wait_for_function('window.__READY__||window.__ERROR__',timeout=240000)
 assert not errors and not page.evaluate('window.__ERROR__'),errors
 native=page.evaluate('({w:app.engine.renderer.domElement.width,h:app.engine.renderer.domElement.height})');assert native=={'w':1920,'h':1080},native
 print('READY',page.evaluate('app.diagnostics().renderer'),build_sha,flush=True)
 for index,shot in enumerate(SHOTS):
  final=OUT/(shot['name']+'.mp4')
  if final.exists() and (OUT/(shot['name']+'.json')).exists():
   print('SKIP COMPLETE',shot['name'],flush=True);reports.append(json.loads((OUT/(shot['name']+'.json')).read_text()));continue
  page.evaluate('(s)=>{app.setPreset(s);app.engine.post.reset();}',shot['scene'])
  page.evaluate('(s)=>app.label(s.title,s.caption,"CYBR / WATER 2.4  •  "+s.number)',{**shot,'number':str(index+1).zfill(2)+' / 05'})
  if shot.get('zoom'):page.evaluate('app.setOrbit({distance:72,pitch:.70,yaw:.52,target:[0,0,0]})')
  else:page.evaluate('(s)=>app.setCamera({eye:s.eye,target:s.target,fov:s.fov})',shot)
  # Resolve static subpixel samples before the first captured frame.
  page.evaluate('for(let i=0;i<8;i++)app.render()')
  log=open(OUT/(shot['name']+'-encode.log'),'w')
  cmd=['ffmpeg','-y','-hide_banner','-loglevel','error','-f','image2pipe','-vcodec','mjpeg','-framerate','24','-i','pipe:0','-an','-c:v','libx264','-preset','fast','-crf','18','-threads','2','-pix_fmt','yuv420p','-movflags','+faststart',str(final)]
  enc=subprocess.Popen(cmd,stdin=subprocess.PIPE,stderr=log);start=time.time();frames=shot['seconds']*24;hashes=[];cameraSamples=[];particleMax={'spray':0,'bubbles':0}
  try:
   for frame in range(frames):
    t=frame/24;u=frame/max(1,frames-1)
    args={**shot,'t':t,'u':u,'frame':frame}
    state=page.evaluate('''(s)=>{
      app.engine.advance(1/24);
      if(s.zoom){
        // Twenty kilometre excursion, then return to the same wave field.
        const a=Math.sin(Math.PI*s.u)**2,d=72*Math.exp(Math.log(20000/72)*a);
        app.setOrbit({distance:d,pitch:.70,yaw:.52+s.u*.12,target:[0,0,0]});
        document.querySelector('#shot-caption').textContent='Orbit distance: '+(d>=1000?(d/1000).toFixed(2)+' km':d.toFixed(1)+' m')+'  •  no application distance cap';
      }else{
        const mix=(a,b)=>a.map((v,i)=>v+(b[i]-v)*s.u);
        app.setCamera({eye:mix(s.eye,s.end),target:mix(s.target,s.targetEnd),fov:s.fov});
      }
      const opacity=s.zoom?1:Math.max(0,Math.min(1,(3.2-s.t)/.9));
      document.querySelector('.film-label').style.opacity=opacity;
      document.querySelector('.title-shadow').style.opacity=opacity*.7;
      app.render();
      return {tick:app.engine.tick,time:app.engine.time,camera:app.engine.currentCamera,particles:app.engine.particles.counts,underwater:app.engine.underwater};
    }''',args)
    if errors:raise RuntimeError(errors[-1])
    data=page.screenshot(type='jpeg',quality=96,animations='disabled');enc.stdin.write(data)
    hashes.append(hashlib.sha256(data).hexdigest())
    for k in particleMax:particleMax[k]=max(particleMax[k],state['particles'][k])
    if frame in [0,frames//4,frames//2,3*frames//4,frames-1]:
     (OUT/f"{shot['name']}-{frame:04}.jpg").write_bytes(data);cameraSamples.append(state)
    if frame%48==0:print('FRAME',shot['name'],frame,'/',frames,'seconds',round(time.time()-start,1),flush=True)
   enc.stdin.close();code=enc.wait(timeout=120);assert code==0,code
  except BaseException:
   enc.kill();raise
  finally:log.close()
  report={'shot':shot,'nativeResolution':native,'fps':24,'frames':frames,'durationSeconds':frames/24,'renderSeconds':time.time()-start,'sourceHTMLSHA256':build_sha,'sourceBundleSHA256':bundle_sha,'frameSHA256':hashes,'cameraSamples':cameraSamples,'maximumParticles':particleMax,'browserErrors':errors[:],'diagnostics':page.evaluate('app.diagnostics(true)')}
  (OUT/(shot['name']+'.json')).write_text(json.dumps(report,indent=2));reports.append(report)
  print('DONE',shot['name'],report['renderSeconds'],particleMax,flush=True)
 browser.close()
(OUT/'capture-validation.json').write_text(json.dumps({'reports':reports,'errors':errors,'warnings':warnings,'sourceHTMLSHA256':build_sha},indent=2))
print('ALL CAPTURES COMPLETE',flush=True)
