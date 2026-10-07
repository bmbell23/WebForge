"""#315: copy the macOS build from GitHub Releases into releases/mac/ for :8012.

dockerhost can't build a .dmg, so GitHub Actions does (#270) and attaches it to
the tag's release a few minutes after the tag is pushed. Nothing here can be told
when that finishes, so this polls: every POLL seconds it asks the public API for
the newest release that carries a latest-mac.yml, and if releases/mac/ holds an
older version it downloads every file that manifest lists, checks each sha512,
then writes latest-mac.yml LAST, so an app never reads a manifest whose files
aren't there yet. The previous version's files are removed afterwards.

Stdlib only, like sync.py. Run: python /app/mac_mirror.py  (tests: test_mac_mirror.py)
"""
import base64
import hashlib
import json
import os
import re
import sys
import time
import urllib.request

REPO = os.environ.get('MIRROR_REPO', 'bmbell23/WebForge')
OUT = os.environ.get('MIRROR_DIR', '/releases/mac')
POLL = int(os.environ.get('MIRROR_POLL', '600'))  # 10 min: 6 calls/h of the 60/h anonymous limit
MANIFEST = 'latest-mac.yml'


def log(msg):
    print(time.strftime('%Y-%m-%dT%H:%M:%SZ', time.gmtime()), msg, flush=True)


def parse_manifest(text):
    """The bits of electron-builder's latest-mac.yml we need: version + files[]."""
    version = None
    files = []
    for line in text.splitlines():
        m = re.match(r'^version:\s*(\S+)', line)
        if m:
            version = m.group(1).strip('\'"')
            continue
        m = re.match(r'^\s*-\s*url:\s*(\S+)', line)
        if m:
            files.append({'url': m.group(1).strip('\'"')})
            continue
        m = re.match(r'^\s+(sha512|size):\s*(\S+)', line)
        if m and files:
            files[-1][m.group(1)] = m.group(2).strip('\'"')
    for f in files:
        # a manifest naming ../ or a URL could write outside OUT: refuse it whole
        if '/' in f['url'] or f['url'].startswith('.'):
            raise ValueError(f'unsafe file name in manifest: {f["url"]}')
    return {'version': version, 'files': files}


def vkey(v):
    return tuple(int(p) for p in re.findall(r'\d+', v or '0'))


def newest_mac_release(releases):
    """First (newest) non-draft release whose assets include latest-mac.yml."""
    for r in releases:
        if r.get('draft') or r.get('prerelease'):
            continue
        assets = {a['name']: a['browser_download_url'] for a in r.get('assets', [])}
        if MANIFEST in assets:
            return {'tag': r['tag_name'], 'assets': assets}
    return None


def stale_files(names, keep):
    """Files in OUT that the current manifest no longer lists (old versions, partials)."""
    return sorted(n for n in names if n not in keep and n != MANIFEST)


def fetch(url, timeout=60):
    req = urllib.request.Request(url, headers={'User-Agent': 'webforge-mac-mirror'})
    return urllib.request.urlopen(req, timeout=timeout)


def download(url, dest, sha512):
    tmp = dest + '.part'
    h = hashlib.sha512()
    with fetch(url, timeout=300) as r, open(tmp, 'wb') as f:
        while True:
            chunk = r.read(1 << 20)
            if not chunk:
                break
            h.update(chunk)
            f.write(chunk)
    got = base64.b64encode(h.digest()).decode()
    if sha512 and got != sha512:
        os.remove(tmp)
        raise ValueError(f'sha512 mismatch for {os.path.basename(dest)}')
    os.replace(tmp, dest)


def local_version():
    try:
        with open(os.path.join(OUT, MANIFEST)) as f:
            return parse_manifest(f.read())['version']
    except FileNotFoundError:
        return None


def cycle():
    with fetch(f'https://api.github.com/repos/{REPO}/releases?per_page=10') as r:
        rel = newest_mac_release(json.load(r))
    if not rel:
        log('no release carries latest-mac.yml yet')
        return
    with fetch(rel['assets'][MANIFEST]) as r:
        raw = r.read()
    man = parse_manifest(raw.decode())
    have = local_version()
    if have and vkey(have) >= vkey(man['version']):
        return
    log(f'mirroring {rel["tag"]} (have {have or "nothing"})')
    os.makedirs(OUT, exist_ok=True)
    for f in man['files']:
        url = rel['assets'].get(f['url'])
        if not url:
            raise ValueError(f'{rel["tag"]} lists {f["url"]} but has no such asset')
        dest = os.path.join(OUT, f['url'])
        if os.path.exists(dest) and str(os.path.getsize(dest)) == f.get('size'):
            continue  # finished on an earlier, interrupted cycle
        log(f'  {f["url"]}')
        download(url, dest, f.get('sha512'))
    tmp = os.path.join(OUT, MANIFEST + '.part')
    with open(tmp, 'wb') as fh:
        fh.write(raw)
    os.replace(tmp, os.path.join(OUT, MANIFEST))
    for n in stale_files(os.listdir(OUT), {f['url'] for f in man['files']}):
        os.remove(os.path.join(OUT, n))
        log(f'  removed {n}')
    log(f'now serving {man["version"]}')


def main():
    log(f'mac mirror: {REPO} -> {OUT} every {POLL}s')
    while True:
        try:
            cycle()
        except Exception as e:  # off the internet, rate limited, bad asset: try again next cycle
            log(f'cycle failed: {e!r}')
        time.sleep(POLL)


if __name__ == '__main__':
    if sys.argv[1:] == ['--once']:
        cycle()
    else:
        main()
