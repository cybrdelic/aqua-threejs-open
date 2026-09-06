"""Check repository packaging, local README links and actual animated previews."""
from pathlib import Path
import hashlib
import json
import re
from PIL import Image

ROOT = Path(__file__).resolve().parents[1]
reports = []
# Validate source files first, then create the manifest linked by the README.
for name in ['dawn-swells', 'whitewater', 'heavy-seas', 'free-zoom']:
    gif = ROOT / 'docs/media' / (name + '.gif')
    report = json.loads(gif.with_suffix('.json').read_text())
    decoded = set()
    duration = 0
    with Image.open(gif) as image:
        assert image.format == 'GIF' and image.is_animated
        assert image.size == (640, 360)
        assert image.n_frames == (100 if name == 'free-zoom' else 40)
        for i in range(image.n_frames):
            image.seek(i)
            frame = image.convert('RGB')
            frame.load()
            decoded.add(hashlib.sha256(frame.tobytes()).hexdigest())
            duration += image.info.get('duration', 0)
        assert len(decoded) > image.n_frames // 2, 'Not an animated capture: ' + name
    assert duration == (10000 if name == 'free-zoom' else 4000), (name, duration)
    assert not report['browserErrors'], report['browserErrors']
    assert hashlib.sha256(gif.read_bytes()).hexdigest() == report['gif']['sha256']
    assert report['sourceBundleSHA256'] == hashlib.sha256((ROOT / 'public/engine-bundle.js').read_bytes()).hexdigest()
    assert 10000 < gif.stat().st_size < 15 * 1024**2
    reports.append(report)
manifest = ROOT / 'docs/media/manifest.json'
manifest.write_text(json.dumps({'kind': 'actual-renderer-gif-captures', 'reports': reports}, indent=2) + '\n')

readme = (ROOT / 'README.md').read_text()
links = re.findall(r'!?\[[^\]]*\]\(([^)]+)\)', readme)
links += re.findall(r'<img[^>]*\bsrc="([^"]+)"', readme)
for link in links:
    if link.startswith(('https://', 'http://', '#', 'mailto:')):
        continue
    path = (ROOT / link.split('#')[0]).resolve()
    assert path.is_relative_to(ROOT) and path.is_file(), f'Broken relative README link: {link}'
assert 'GNU GENERAL PUBLIC LICENSE' in (ROOT / 'LICENSE').read_text()
assert 'MIT License' in (ROOT / 'licenses/CYBR-WATER-MIT.txt').read_text()
print(f'PASS: {len(links)} README links checked; all four animated GIFs fully decoded; source hash and license checks passed.')
