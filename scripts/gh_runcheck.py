#!/usr/bin/env python3
"""Check GitHub Actions runs + trigger workflow_dispatch cho build-windows.yml.
Token đọc runtime từ upload/work.txt — KHÔNG BAO GIỜ in token."""
import re, sys, json, urllib.request, urllib.error, pathlib

WORK = pathlib.Path('/home/z/my-project/upload/work.txt')
txt = WORK.read_text(errors='ignore')
m = re.search(r'github_pat_[A-Za-z0-9_]+', txt)
if not m:
    print('NO_PAT_FOUND'); sys.exit(1)
TOKEN = m.group(0)
REPO = 'victoryvpsvn-star/nexus-optimizer'
API = f'https://api.github.com/repos/{REPO}'

def req(url, method='GET', data=None):
    body = json.dumps(data).encode() if data is not None else None
    r = urllib.request.Request(url, headers={
        'Authorization': f'Bearer {TOKEN}',
        'Accept': 'application/vnd.github+json',
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

mode = sys.argv[1] if len(sys.argv) > 1 else 'status'

if mode == 'status':
    st, data = req(f'{API}/actions/runs?per_page=5')
    print('HTTP', st)
    for run in data.get('workflow_runs', [])[:5]:
        print(f"  #{run['run_number']} [{run['name']}] {run['status']}/{run.get('conclusion')} | event={run['event']} | head={run['head_sha'][:7]} | {run['html_url']}")
elif mode == 'dispatch':
    st, data = req(f'{API}/actions/workflows/build-windows.yml/dispatches', method='POST',
                   data={'ref': 'main'})
    print('DISPATCH HTTP', st, data.get('message', 'OK' if st == 204 else ''))
