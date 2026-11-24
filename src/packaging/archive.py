"""Small stdlib ZIP/PSD verifier. Called with JSON on stdin; never shells out."""
import hashlib
import json
import os
from pathlib import Path, PurePosixPath
import shutil
import stat
import struct
import sys
import zipfile


def safe(name):
    path = PurePosixPath(name)
    if (not name or name.startswith('/') or '\\' in name or ':' in name
            or any(ord(c) < 32 or ord(c) == 127 for c in name)
            or any(p in ('', '.', '..') or p.startswith('.') for p in name.split('/'))):
        raise ValueError('unsafe archive member')
    return path


def members(archive):
    result = {}
    folded = set()
    total = 0
    for entry in archive.infolist():
        name = entry.filename.rstrip('/')
        safe(name)
        mode = entry.external_attr >> 16
        if stat.S_ISLNK(mode) or (stat.S_IFMT(mode) not in (0, stat.S_IFREG, stat.S_IFDIR)):
            raise ValueError('archive link or special file')
        if name.casefold() in folded or entry.flag_bits & 1:
            raise ValueError('duplicate, case collision or encrypted archive member')
        folded.add(name.casefold())
        if entry.is_dir():
            continue
        total += entry.file_size
        if total > 4 * 1024**3 or len(result) >= 200000:
            raise ValueError('archive exceeds inspection budget')
        result[name] = entry
    return result


def sha(stream):
    h = hashlib.sha256()
    for chunk in iter(lambda: stream.read(1024 * 1024), b''):
        h.update(chunk)
    return h.hexdigest()


def verify_project(file):
    with zipfile.ZipFile(file) as archive:
        entries = members(archive)
        manifest = json.loads(archive.read('manifest.json'))
        if manifest.get('format') != 'PSD2Live' or manifest.get('version') != 2:
            raise ValueError('not a supported native PSD2Live project archive')
        expected = manifest.get('files')
        if not isinstance(expected, dict) or set(expected) != set(entries) - {'manifest.json'}:
            raise ValueError('native project inventory mismatch')
        for name, expected_hash in expected.items():
            with archive.open(entries[name]) as stream:
                if sha(stream) != expected_hash:
                    raise ValueError('native project hash mismatch: ' + name)
            if name.startswith(('document/nodes/', 'document/overrides/', 'document/clips/', 'document/bakes/', 'rig/objects/')):
                if PurePosixPath(name).stem != expected_hash:
                    raise ValueError('native content-addressed resource name mismatch')
        if not any(n.startswith('assets/') or '/blobs/' in n for n in entries):
            raise ValueError('native project has no embedded artwork')
        if 'history/HEAD.json' not in entries:
            raise ValueError('native project has no history HEAD')
        head = json.loads(archive.read('history/HEAD.json'))
        order = head.get('nodeOrder')
        if not isinstance(order, list) or not order or head.get('headNodeId') not in order:
            raise ValueError('native project has no valid history order/HEAD')
        for node_id in order:
            node_path = 'history/nodes/' + hashlib.sha256(node_id.encode()).hexdigest() + '.json'
            if node_path not in entries:
                raise ValueError('native history node missing')
            node = json.loads(archive.read(node_path))
            snapshot = node.get('snapshotHash')
            if node.get('id') != node_id or not isinstance(snapshot, str):
                raise ValueError('native history identity missing')
            revision = 'history/revisions/' + hashlib.sha256(snapshot.encode()).hexdigest() + '.json'
            if revision not in entries:
                raise ValueError('native history revision missing')
        # Native v2 saves rasters/nodes in the envelope. Check serialized raster
        # references as well as the archive inventory; an inventory alone cannot
        # detect a missing raster that was omitted by the producer.
        def references(value):
            if isinstance(value, dict):
                for key, child in value.items():
                    if key == 'rgbaBlob' and isinstance(child, str):
                        width = value.get('rasterWidth', value.get('pixelWidth'))
                        height = value.get('rasterHeight', value.get('pixelHeight'))
                        if not isinstance(width, int) or not isinstance(height, int) or width < 0 or height < 0:
                            raise ValueError('native raster dimensions missing')
                        key_hash = hashlib.sha256(child.encode()).hexdigest()
                        target = 'assets/' + key_hash + (f'-{width}x{height}.png' if width and height else '.rgba.gz')
                        if target not in entries and 'assets/' + key_hash + '.rgba.gz' not in entries:
                            raise ValueError('missing embedded raster: ' + target)
                    if key in ('sessionKey', 'sessionId', 'access_token', 'apiKey', 'privateKey', 'privateRequest'):
                        raise ValueError('private runtime metadata in editable archive')
                    references(child)
            elif isinstance(value, list):
                for child in value:
                    references(child)
        for name, entry in entries.items():
            if name.endswith('.json') and name != 'manifest.json':
                if entry.file_size > 64 * 1024**2:
                    raise ValueError('project JSON exceeds inspection budget')
                references(json.loads(archive.read(entry)))
        for name in entries:
            if name.startswith('history/revisions/') and name.endswith('.json'):
                index = json.loads(archive.read(name))
                for kind, value in index.get('nodes', {}).items():
                    target = f'document/nodes/{kind}/{value}.json'
                    if target not in entries:
                        raise ValueError('missing document node: ' + target)
                for key, folder, extension in [('overrides', 'document/overrides', 'json'), ('clips', 'document/clips', 'json'),
                                                ('payloads', 'document/nodes/payload', 'json'), ('bakes', 'document/bakes', 'bin'),
                                                ('rig', 'rig/objects', 'bin')]:
                    values = index.get(key, [])
                    if isinstance(values, str):
                        values = [values]
                    for value in values:
                        if f'{folder}/{value}.{extension}' not in entries:
                            raise ValueError('missing document dependency: ' + key)
        return {'format': 'PSD2Live', 'version': manifest['version'],
                'projectId': manifest.get('projectId'), 'embeddedFiles': len(expected),
                'inventoryHashes': 'passed', 'nativeReopen': 'not_run'}


def verify_psd(file):
    size = os.path.getsize(file)
    with open(file, 'rb') as stream:
        header = stream.read(26)
        if len(header) != 26 or header[:6] != b'8BPS\x00\x01':
            raise ValueError('not a PSD v1 file')
        for _ in range(2):
            length = struct.unpack('>I', stream.read(4))[0]
            if stream.tell() + length + 4 > size:
                raise ValueError('truncated PSD')
            stream.seek(length, 1)
        section = struct.unpack('>I', stream.read(4))[0]
        if section < 6 or stream.tell() + section > size:
            raise ValueError('PSD missing layer/mask section')
        layer_info = struct.unpack('>I', stream.read(4))[0]
        count = abs(struct.unpack('>h', stream.read(2))[0])
        if layer_info < 2 or layer_info + 4 > section or count < 2:
            raise ValueError('PSD is flattened or has no layered source')
        layer_end = stream.tell() - 2 + layer_info
        channel_bytes = 0
        raster_layers = 0
        for _ in range(count):
            if stream.tell() + 18 > layer_end:
                raise ValueError('truncated PSD layer record')
            top, left, bottom, right = struct.unpack('>iiii', stream.read(16))
            channels = struct.unpack('>H', stream.read(2))[0]
            if channels > 56 or bottom < top or right < left:
                raise ValueError('invalid PSD layer channels')
            if channels and bottom > top and right > left:
                raster_layers += 1
            for _ in range(channels):
                raw = stream.read(6)
                if len(raw) != 6:
                    raise ValueError('truncated PSD channel record')
                length = struct.unpack('>hI', raw)[1]
                if length < 2:
                    raise ValueError('PSD channel missing compression header')
                channel_bytes += length
            if stream.read(4) != b'8BIM':
                raise ValueError('invalid PSD layer blend signature')
            stream.read(8)
            raw = stream.read(4)
            if len(raw) != 4:
                raise ValueError('truncated PSD layer extra data')
            extra = struct.unpack('>I', raw)[0]
            if extra < 12 or stream.tell() + extra > layer_end:
                raise ValueError('invalid PSD layer extra data')
            stream.seek(extra, 1)
        if stream.tell() + channel_bytes > layer_end or raster_layers < 2:
            raise ValueError('PSD layer pixel data missing')
        return {'format': 'PSD', 'layerRecordCount': count, 'rasterLayerCount': raster_layers, 'decodedArt': 'not_run'}


def run(request):
    action = request['action']
    if action == 'project':
        return verify_project(request['file'])
    if action == 'psd':
        return verify_psd(request['file'])
    if action == 'list':
        with zipfile.ZipFile(request['file']) as archive:
            return {'files': list(members(archive))}
    if action == 'make':
        root = Path(request['root']).resolve()
        # Exact whitelist, never recurse a project or copy private state.
        with zipfile.ZipFile(request['file'], 'x', compression=zipfile.ZIP_DEFLATED, compresslevel=6) as archive:
            for name in sorted(request['files']):
                safe(name)
                source = root / name
                if source.is_symlink() or not source.is_file() or source.resolve() != source:
                    raise ValueError('unsafe ZIP source')
                info = zipfile.ZipInfo(name, date_time=(2026, 1, 1, 0, 0, 0))
                info.compress_type = zipfile.ZIP_STORED if request.get('store') is True else zipfile.ZIP_DEFLATED
                info.external_attr = (stat.S_IFREG | 0o644) << 16
                with source.open('rb') as src, archive.open(info, 'w', force_zip64=True) as dest:
                    shutil.copyfileobj(src, dest, 1024 * 1024)
        return {'created': True}
    if action == 'extract':
        root = Path(request['root']).resolve()
        if request.get('existingEmpty'):
            if not root.is_dir() or any(root.iterdir()):
                raise ValueError('extraction destination is not empty')
        else:
            root.mkdir(exist_ok=False)
        with zipfile.ZipFile(request['file']) as archive:
            entries = members(archive)
            if set(entries) != set(request['files']):
                raise ValueError('ZIP entries differ from exact package inventory')
            for name, entry in entries.items():
                dest = root / name
                dest.parent.mkdir(parents=True, exist_ok=True)
                with archive.open(entry) as src, dest.open('xb') as out:
                    shutil.copyfileobj(src, out, 1024 * 1024)
        return {'extracted': len(entries)}
    raise ValueError('unknown archive action')


if __name__ == '__main__':
    try:
        print(json.dumps({'ok': True, 'result': run(json.load(sys.stdin))}, ensure_ascii=False))
    except Exception as error:
        print(json.dumps({'ok': False, 'error': str(error)}, ensure_ascii=False))
        sys.exit(1)
