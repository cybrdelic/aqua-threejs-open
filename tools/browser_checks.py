"""Check GPU fields and actual zoom input events in Chromium.
Runs on the caller's GPU; tests do not claim a physical Android pass.
"""
from pathlib import Path
import os, json, time, math, shutil, hashlib
from playwright.sync_api import sync_playwright

ROOT = Path(__file__).resolve().parents[1]
OUT = ROOT / 'docs'
OUT.mkdir(exist_ok=True)
html = (ROOT / 'public/standalone.html').read_text()
errors, warnings, reports = [], [], {}
start = time.time()
with sync_playwright() as pw:
    exe = os.getenv('CHROMIUM_EXECUTABLE') or shutil.which('chromium') or shutil.which('google-chrome')
    options = dict(headless=True, args=['--no-sandbox', '--disable-dev-shm-usage', '--use-gl=angle', '--use-angle=gl', '--ignore-gpu-blocklist', '--enable-unsafe-swiftshader'], env={**os.environ, 'LIBGL_ALWAYS_SOFTWARE':'1', 'LP_NUM_THREADS':'2'})
    if exe:
        options['executable_path'] = exe
    browser = pw.chromium.launch(**options)
    context = browser.new_context(viewport={'width':390,'height':780}, device_scale_factor=1, has_touch=True, is_mobile=True)
    page = context.new_page()
    page.set_default_timeout(240000)
    page.on('pageerror', lambda e: errors.append(str(e)))
    page.on('console', lambda m: errors.append(m.text) if m.type=='error' else (warnings.append(m.text) if m.type=='warning' else None))
    page.evaluate("window.__QUERY__='?capture=1&width=390&height=780&quality=low&grid=128&scene=blue'")
    page.set_content(html, wait_until='domcontentloaded', timeout=240000)
    page.wait_for_function('window.__READY__||window.__ERROR__', timeout=240000)
    assert not errors and not page.evaluate('window.__ERROR__'), errors
    reports['renderer'] = page.evaluate('app.diagnostics().renderer')
    reports['sourceHTMLSHA256'] = hashlib.sha256(html.encode()).hexdigest()
    print('READY', reports['renderer'], flush=True)

    page.evaluate('app.setOrbit({distance:100,pitch:.6,yaw:.7,target:[0,0,0]});app.render()')
    initial = page.evaluate('app.orbitState().distance')
    page.mouse.move(190, 300)
    page.mouse.wheel(0, 1100)
    page.wait_for_timeout(300)
    wheeled = page.evaluate('app.orbitState().distance')
    assert wheeled>500, (initial, wheeled)
    print('WHEEL', wheeled, flush=True)

    cdp=context.new_cdp_session(page)
    def touches(xs, kind):
        cdp.send('Input.dispatchTouchEvent', {'type':kind,'touchPoints':[{'x':x,'y':340,'radiusX':2,'radiusY':2,'force':1,'id':i+1} for i,x in enumerate(xs)]})
    before=page.evaluate('app.orbitState().distance')
    touches([60,330], 'touchStart')
    for delta in [10,20,30,40,50,60]:
        touches([60+delta,330-delta], 'touchMove')
        page.wait_for_timeout(30)
    touches([], 'touchEnd')
    pinchOut=page.evaluate('app.orbitState().distance')
    assert pinchOut>before*1.6,(before,pinchOut)
    touches([120,270], 'touchStart')
    for delta in [10,20,30,40,50,60]:
        touches([120-delta,270+delta], 'touchMove')
        page.wait_for_timeout(30)
    touches([], 'touchEnd')
    pinchIn=page.evaluate('app.orbitState().distance')
    assert pinchIn<pinchOut*.7,(pinchOut,pinchIn)
    reports['inputZoom']={'initialMetres':initial,'wheelMetres':wheeled,'pinchOutMetres':pinchOut,'pinchInMetres':pinchIn,'touchEvents':'Chromium CDP native touch injection','passed':True}
    print('PINCH',reports['inputZoom'],flush=True)

    distances=[]
    for distance in [500,5000,100000,1000000]:
        d=page.evaluate('''(distance)=>{app.setOrbit({distance,pitch:.70,yaw:.65,target:[0,0,0]});app.render();return {requested:distance,actual:app.engine.camera.position.length(),near:app.engine.camera.near,far:app.engine.camera.far,capIsInfinity:app.orbitState().maxDistance===Infinity};}''', distance)
        assert abs(d['actual']/distance-1)<1e-8,d
        assert d['near']>0 and d['far']>distance and d['capIsInfinity'],d
        distances.append(d)
    reports['zoomRange']=distances
    page.screenshot(path=str(ROOT/'review/portrait-million-metres.png'))
    print('RANGE',distances,flush=True)

    page.evaluate('app.setPreset("whitewater");app.setOrbit({distance:65,pitch:.65,yaw:.5,target:[0,0,0]});for(let i=0;i<4;i++)app.frame(1/24)')
    page.screenshot(path=str(ROOT/'review/portrait-whitewater24.png'))
    normalCheck=page.evaluate(r'''()=>{
      const e=app.engine,r=e.renderer,T=window.THREE,base=e.waterMaterial.fragmentShader;
      app.setCamera({eye:[25,22,35],target:[4,0,0],fov:48});app.setDebug(1);
      const debug=source=>source.replace('if(uDebug==1)color=N*.5+.5;','if(uDebug==1)color=N.y<0.?vec3(1.,0.,0.):vec3(0.,1.,0.);');
      const measure=source=>{e.waterMaterial.fragmentShader=debug(source);e.waterMaterial.needsUpdate=true;e.post.reset();app.render();const a=new Uint16Array(e.width*e.height*4);r.readRenderTargetPixels(e.mainRT,0,0,e.width,e.height,a);let down=0;for(let i=0;i<a.length;i+=4){if(T.DataUtils.fromHalfFloat(a[i])>.5&&T.DataUtils.fromHalfFloat(a[i+1])<.5)down++;}return down;};
      const start=base.indexOf('vec3 N=normalize(cross(tz,tx)),V='),end=base.indexOf('\n bool under=',start);
      if(start<0||end<0)throw Error('Normal instrumentation location missing');
      const old=base.slice(0,start)+'vec3 N=normalize(cross(tz,tx)),V=normalize(uEye-vWorld);if(dot(N,V)<0.)N=-N;'+base.slice(end);
      const before=measure(old),after=measure(base);e.waterMaterial.fragmentShader=base;e.waterMaterial.needsUpdate=true;app.setDebug(0);e.post.reset();app.render();
      return {beforeDownwardPixels:before,afterDownwardPixels:after,resolution:[e.width,e.height],view:'Whitewater overhead, above water',method:'GPU-rendered orientation mask, half-float readback'};
    }''')
    reports['shadingNormalCorrection']=normalCheck
    assert normalCheck['beforeDownwardPixels']>0,normalCheck
    assert normalCheck['afterDownwardPixels']==0,normalCheck
    print('NORMAL ORIENTATION',normalCheck,flush=True)
    page.screenshot(path=str(ROOT/'review/portrait-whitewater-final.png'))
    fields = page.evaluate('app.engine.ocean.verify(62.5)')
    reports['gpuCPUFields']=fields
    # All exposed fieldError max values must agree with the independent CPU FFT.
    def maxima(obj):
        result=[]
        if isinstance(obj,dict):
            for k,v in obj.items():
                if k in ['max','maxAbs','maxError'] and isinstance(v,(int,float)):
                    result.append(v)
                result.extend(maxima(v))
        elif isinstance(obj,list):
            for v in obj: result.extend(maxima(v))
        return result
    mm=maxima(fields)
    assert mm and max(mm)<2e-4,(mm,fields)
    print('GPU FFT max',max(mm),flush=True)

    white=page.evaluate('''()=>{
        const e=app.engine,r=e.renderer,w=e.whitewater,T=window.THREE;
        const preset={...e.preset,hs:0,foamLifetime:12,wind:0};
        e.ocean.reset(preset);e.ocean.step(0);w.reset();w.step(.25,preset);
        const summarize=()=>{
            const data=new Uint16Array(w.n*w.n*4);r.readRenderTargetPixels(w.a,0,0,w.n,w.n,data);
            const min=[Infinity,Infinity,Infinity,Infinity],max=[-Infinity,-Infinity,-Infinity,-Infinity],sum=[0,0,0,0];let finite=true;
            for(let i=0;i<data.length;i++){const x=T.DataUtils.fromHalfFloat(data[i]),k=i%4;finite=finite&&Number.isFinite(x);min[k]=Math.min(min[k],x);max[k]=Math.max(max[k],x);sum[k]+=x;}
            return {min,max,mean:sum.map(x=>x/(w.n*w.n)),finite};
        };
        const flat=summarize();
        r.setRenderTarget(w.a);r.setClearColor(new T.Color(.8,3,.6),1);r.clear();r.setRenderTarget(null);w.step(.25,preset);const decay=summarize();
        return {flat,decay,expected:[.8*Math.exp(-.25/12),3.25,.6*Math.exp(-.25/.9),1],size:w.size,resolution:w.n};
    }''')
    reports['whitewater']=white
    assert white['flat']['finite'] and white['decay']['finite'],white
    assert max(white['flat']['max'][:3])<.0001,white
    assert abs(white['flat']['mean'][3]-1)<.001,white
    for actual,expected in zip(white['decay']['mean'],white['expected']):
        assert abs(actual-expected)<.003,(actual,expected,white)
    assert max(b-a for a,b in zip(white['decay']['min'],white['decay']['max']))<.001,white
    print('WHITEWATER',white,flush=True)

    page.evaluate('app.setPreset("shallows");app.setCamera({eye:[8,-2.5,11],target:[-10,-4,-15],fov:58});for(let i=0;i<4;i++)app.frame(1/24)')
    page.screenshot(path=str(ROOT/'review/portrait-shallows24.png'))
    assert not errors,errors
    reports['browserErrors']=errors
    reports['warnings']=warnings
    reports['passed']=True
    reports['elapsedSeconds']=time.time()-start
    (OUT/'browser-checks24.json').write_text(json.dumps(reports,indent=2))
    print('ALL BROWSER CHECKS PASSED',flush=True)
    browser.close()
