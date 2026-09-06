"""Verify transport and reconstruct the exact imported release, preserving LICENSE."""
from pathlib import Path, PurePosixPath
import argparse, base64, hashlib, io, json, lzma, time, urllib.request, zipfile


def digest(data):
    return hashlib.sha256(data).hexdigest()


def destination(root, name):
    rel = PurePosixPath(name)
    if rel.is_absolute() or '..' in rel.parts or rel.parts[0] in ('.git', '.github', '.import') or name == 'LICENSE':
        raise ValueError('Unsafe import destination: ' + name)
    path = (root / name).resolve()
    if not path.is_relative_to(root):
        raise ValueError('Destination escapes repository: ' + name)
    return path


def verify(root):
    manifest = json.loads((root / 'docs/import-manifest.json').read_text())
    for name, expected in manifest['importedFiles'].items():
        path = destination(root, name)
        assert path.is_file(), 'Missing imported file: ' + name
        assert digest(path.read_bytes()) == expected, 'Imported file differs: ' + name
    license_data = (root / 'LICENSE').read_bytes()
    git_blob = hashlib.sha1(b'blob ' + str(len(license_data)).encode() + b'\0' + license_data).hexdigest()
    assert git_blob == 'd159169d1050894d3ea3b98e1c965c4058208fe1', 'Existing GPL license changed'
    print('VERIFIED', len(manifest['importedFiles']), 'exact imported files and unchanged GPL LICENSE', flush=True)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--root', default='.')
    parser.add_argument('--base-archive')
    parser.add_argument('--verify-only', action='store_true')
    args = parser.parse_args()
    root = Path(args.root).resolve()
    if args.verify_only:
        verify(root)
        return
    manifest = json.loads((root / '.import/manifest.json').read_text())
    chunks = []
    for part in manifest['parts']:
        data = (root / part['path']).read_bytes()
        assert len(data) == part['length'], 'Transport length mismatch: ' + part['path']
        assert digest(data) == part['sha256'], 'Transport hash mismatch: ' + part['path']
        chunks.append(data)
    compressed = base64.b64decode(b''.join(chunks), validate=True)
    assert digest(compressed) == manifest['payloadSHA256'], 'Payload hash mismatch'
    records = json.loads(lzma.decompress(compressed))
    assert len(records) == manifest['files']
    if args.base_archive:
        archive = Path(args.base_archive).read_bytes()
    else:
        for attempt in range(4):
            try:
                request = urllib.request.Request(manifest['baseArchiveURL'], headers={'User-Agent': 'AQUA-source-import/1'})
                with urllib.request.urlopen(request, timeout=120) as response:
                    archive = response.read()
                break
            except Exception:
                if attempt == 3:
                    raise
                time.sleep(3 * (attempt + 1))
    assert digest(archive) == manifest['baseArchiveSHA256'], 'Base archive hash mismatch'
    with zipfile.ZipFile(io.BytesIO(archive)) as base:
        for name, record in records.items():
            path = destination(root, name)
            if isinstance(record, str):
                data = record.encode('utf-8')
            else:
                previous = base.read('CYBR-WATER-II/' + record['base'])
                out = []
                for op in record['ops']:
                    if isinstance(op, str):
                        out.append(op.encode('latin1'))
                    else:
                        offset, length = op
                        assert 0 <= offset <= len(previous) and 0 <= length <= len(previous) - offset
                        out.append(previous[offset:offset + length])
                data = b''.join(out)
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_bytes(data)
        assets = json.loads((root / '.import-assets.json').read_text())
        for name, asset in assets.items():
            member = 'public/vendor/three.global.js' if name == 'public/vendor.js' else name
            data = base.read('CYBR-WATER-II/' + member)
            assert digest(data) == asset['sha256'], 'Binary asset hash mismatch: ' + name
            path = destination(root, name)
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_bytes(data)
    (root / '.import-assets.json').unlink()
    print('RESTORED', len(records), 'text files and', len(assets), 'verified binary assets', flush=True)


if __name__ == '__main__':
    main()
