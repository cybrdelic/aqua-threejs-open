"""Join completed native captures, attach chapters, and verify decoding.
No scaling or frame interpolation is performed. Keeps each take's original encode.
"""
from pathlib import Path
import json, subprocess, shutil, hashlib, sys

ROOT = Path(__file__).resolve().parents[1]
CAPTURE = ROOT / 'capture/output'
DELIVERY = ROOT / 'delivery'
DELIVERY.mkdir(parents=True, exist_ok=True)


def run(argv: list[str]) -> str:
    completed = subprocess.run(argv, check=True, text=True, capture_output=True)
    return completed.stdout


def probe(path: Path) -> dict:
    return json.loads(run(['ffprobe', '-v', 'error', '-count_frames',
        '-select_streams', 'v:0', '-show_streams', '-show_format',
        '-of', 'json', str(path)]))


shots = json.loads((CAPTURE / 'shots.json').read_text())
reports = []
for shot in shots:
    path = CAPTURE / (shot['name'] + '.mp4')
    report_path = CAPTURE / (shot['name'] + '.json')
    if not path.is_file() or not report_path.is_file():
        raise RuntimeError(f'Capture is not complete: {shot["name"]}. No partial reel was assembled.')
    report = json.loads(report_path.read_text())
    p = probe(path)
    stream = p['streams'][0]
    assert (stream['width'], stream['height']) == (1920, 1080), p
    assert stream['r_frame_rate'] == '24/1', p
    assert int(stream['nb_read_frames']) == 24 * shot['seconds'], p
    assert abs(float(p['format']['duration']) - shot['seconds']) < .02, p
    assert not report['browserErrors'], report['browserErrors']
    assert report['diagnostics']['surface']['finite'], report['diagnostics']['surface']
    assert report['diagnostics']['interaction']['finite'], report['diagnostics']['interaction']
    assert report['frames'] == int(stream['nb_read_frames'])
    assert len(set(report['frameSHA256'])) == report['frames'], 'Repeated identical frame bytes'
    reports.append({'name':shot['name'], 'file':path.name,
        'width':stream['width'], 'height':stream['height'],
        'frames':int(stream['nb_read_frames']), 'duration':float(p['format']['duration']),
        'sourceHTMLSHA256':report['sourceHTMLSHA256'],
        'sourceBundleSHA256':report['sourceBundleSHA256'],
        'renderSeconds':report['renderSeconds'], 'maximumParticles':report['maximumParticles'],
        'sha256':hashlib.sha256(path.read_bytes()).hexdigest(),
        'browserErrors':report['browserErrors']})

assert len({r['sourceHTMLSHA256'] for r in reports}) == 1, 'Captures mix multiple source builds'
html_hash = hashlib.sha256((ROOT/'public/standalone.html').read_bytes()).hexdigest()
assert html_hash == reports[0]['sourceHTMLSHA256'], 'Delivered HTML changed after capture'
manifest_path = DELIVERY / 'concat.txt'
manifest_path.write_text('\n'.join("file '"+str((CAPTURE/(s['name']+'.mp4')).resolve()).replace("'", "'\\''")+"'" for s in shots)+'\n')
metadata = [';FFMETADATA1', 'title=CYBR WATER 2.4 — Waves, Whitewater & Free Zoom',
            'comment=New native 1920x1080 Three.js renderer captures. Offline rendering; 24 fps playback.']
t = 0
for shot in shots:
    metadata += ['[CHAPTER]','TIMEBASE=1/1000',f'START={t*1000}',
                 f'END={(t+shot["seconds"])*1000}',f'title={shot["title"]}']
    t += shot['seconds']
meta_path=DELIVERY/'chapters.txt';meta_path.write_text('\n'.join(metadata)+'\n')
movie=DELIVERY/'CYBR-WATER-2.4-Waves-and-Whitewater.mp4'
master=DELIVERY/'CYBR-WATER-2.4-High-Bitrate-Master.mp4'
run(['ffmpeg','-hide_banner','-loglevel','error','-y','-f','concat','-safe','0',
     '-i',str(manifest_path),'-i',str(meta_path),'-map','0:v:0','-map_metadata','1',
     '-map_chapters','1','-c:v','copy','-an','-movflags','+faststart',str(master)])
# A smaller viewing encode and the untouched high-bitrate master are both kept.
# Native resolution/frame count stay unchanged in the viewing copy.
run(['ffmpeg','-hide_banner','-loglevel','error','-y','-i',str(master),
     '-map','0:v:0','-map_metadata','0','-map_chapters','0','-c:v','libx264',
     '-preset','medium','-crf','20','-maxrate','20000k','-bufsize','40000k',
     '-threads','3','-pix_fmt','yuv420p','-an','-movflags','+faststart',str(movie)])
p=probe(movie);v=p['streams'][0]
assert int(v['nb_read_frames'])==sum(r['frames'] for r in reports),p
assert abs(float(p['format']['duration'])-t)<.03,p
assert v['width']==1920 and v['height']==1080 and v['r_frame_rate']=='24/1',p
# A full decode catches truncated media and codec corruption beyond metadata.
run(['ffmpeg','-hide_banner','-v','error','-xerror','-i',str(movie),'-map','0:v:0','-f','null','-'])
report={'movie':movie.name,'durationSeconds':float(p['format']['duration']),
        'frames':int(v['nb_read_frames']),'resolution':[1920,1080],'frameRate':'24/1',
        'fullDecodePassed':True,'bytes':movie.stat().st_size,
        'movieSHA256':hashlib.sha256(movie.read_bytes()).hexdigest(),
        'sourceHTMLSHA256':html_hash,
        'master':{'file':master.name,'bytes':master.stat().st_size,'sha256':hashlib.sha256(master.read_bytes()).hexdigest(),'encoding':'Original per-take H.264 streams concatenated without re-encoding'},
        'viewingEncoding':{'codec':'H.264','crf':20,'maximumRateKbps':20000,'resolutionUnchanged':True,'frameCountUnchanged':True},
        'capture':'Actual Chromium / Three.js renderer, offline rendering, fixed 60Hz physics. No upscaling or frame interpolation.',
        'shots':reports}
(ROOT/'docs/video-validation.json').write_text(json.dumps(report,indent=2))
shutil.copyfile(ROOT/'public/standalone.html',DELIVERY/'CYBR-WATER-2.4.html')
print(json.dumps(report,indent=2))
