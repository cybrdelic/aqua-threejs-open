"""Build the edited source modules into the web app and fully offline HTML."""
from pathlib import Path
import json,gzip,base64
root=Path(__file__).resolve().parents[1]
order=json.loads((root/'source/order.json').read_text())
code='const __M={}; window.__MODULES__=__M;\n'+''.join((root/'source'/n).read_text() for n in order)
vendor=(root/'public/vendor.js').read_text()
assets={}
for p in sorted((root/'public/assets').iterdir()):
 if p.is_file():
  raw=p.read_bytes();z=gzip.compress(raw,compresslevel=6,mtime=0)
  assets['assets/'+p.name]={'data':base64.b64encode(z).decode(),'gzip':True}
asset_script='window.__ASSETS__='+json.dumps(assets,separators=(',',':'))+';'
s=(root/'source/template.html').read_text()
(root/'public/index.html').write_text(s)
(root/'public/engine-bundle.js').write_text(code)
standalone=s.replace('<script src="vendor.js"></script>','<script>'+vendor+'</script><script>'+asset_script+'</script>').replace('<script type="module" src="engine-bundle.js"></script>','<script type="module">'+code+'</script>')
(root/'public/standalone.html').write_text(standalone)
print('Built source bytes:',len(code),'Offline HTML bytes:',len(standalone))
