#!/usr/bin/env python3
"""Set GitHub Actions secrets (from upload/work.txt) + dispatch backup workflow. Never prints secrets."""
import re, sys, json, base64, pathlib, urllib.request, urllib.error

WORK = pathlib.Path('/home/z/my-project/upload/work.txt')
txt = WORK.read_text(errors='ignore')

pat = re.search(r'github_pat_[A-Za-z0-9_]+', txt)
keysets = re.findall(r'(GK[a-z0-9]+)\n+Copy\s*\n+Secret Access Key\s*\n+([0-9a-f]{64})', txt)
webhook = re.search(r'https://discord\.com/api/webhooks/[\w/.-]+', txt)

if not pat or not keysets:
    print('MISSING_CREDS'); sys.exit(1)
TOKEN = pat.group(0)
AK, SK = keysets[0]  # keyset #1 = verified working

API = 'https://api.github.com'
OWNER = 'victoryvpsvn-star'
REPO = 'nexus-optimizer'

def req(url, method='GET', data=None):
    body = json.dumps(data).encode() if data is not None else None
    r = urllib.request.Request(url, headers={
        'Authorization': f'Bearer {TOKEN}',
        'Accept': 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28',
        'User-Agent': 'nexus-ops',
        'Content-Type': 'application/json',
    }, method=method, data=body)
    try:
        with urllib.request.urlopen(r, timeout=30) as resp:
            raw = resp.read()
            return resp.status, (json.loads(raw) if raw else {})
    except urllib.error.HTTPError as e:
        raw = e.read()
        try:
            return e.code, (json.loads(raw) if raw else {})
        except Exception:
            return e.code, {}
    except Exception as e:
        return -1, {'message': str(e)}

def set_secret(name: str, value: str) -> bool:
    st, pk = req(f'{API}/repos/{OWNER}/{REPO}/actions/secrets/public-key')
    if st != 200:
        print(f'SECRET {name}: public-key FAIL {st} {pk.get("message", "")}')
        return False
    from nacl import encoding, public
    sealed = public.SealedBox(public.PublicKey(pk['key'].encode(), encoding.Base64Encoder()))
    enc = sealed.encrypt(value.encode())
    st2, resp = req(f'{API}/repos/{OWNER}/{REPO}/actions/secrets/{name}', method='PUT', data={
        'encrypted_value': base64.b64encode(enc).decode(),
        'key_id': pk['key_id'],
    })
    print(f'SECRET {name}: HTTP {st2}')
    return st2 in (201, 204)

SECRETS = {
    'S3_ACCESS_KEY_ID': AK,
    'S3_SECRET_KEY': SK,
    'S3_BUCKET': 'vic',
    'S3_ENDPOINT': 'https://u3-asia.altare.global',
    'S3_REGION': 'asia',
}
if webhook:
    SECRETS['DISCORD_WEBHOOK_URL'] = webhook.group(0)

ok = True
for name, value in SECRETS.items():
    ok = set_secret(name, value) and ok

st, resp = req(f'{API}/repos/{OWNER}/{REPO}/actions/workflows/backup.yml/dispatches', method='POST', data={'ref': 'main'})
print('DISPATCH backup.yml: HTTP', st, '' if st == 204 else resp.get('message', ''))
sys.exit(0 if ok else 2)
