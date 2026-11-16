#!/usr/bin/env python3
"""GitHub ops driven by PAT stored in upload/work.txt. Token is NEVER printed."""
import re, sys, json, urllib.request, urllib.error, pathlib

WORK = pathlib.Path('/home/z/my-project/upload/work.txt')
txt = WORK.read_text(errors='ignore')
m = re.search(r'github_pat_[A-Za-z0-9_]+', txt)
if not m:
    print('NO_PAT_FOUND'); sys.exit(1)
TOKEN = m.group(0)

API = 'https://api.github.com'

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

def list_repos():
    repos, page = [], 1
    while True:
        st, data = req(f'{API}/user/repos?per_page=100&page={page}&sort=updated')
        if st != 200:
            print('LIST_FAIL', st, data.get('message') if isinstance(data, dict) else data)
            return None
        if not data:
            break
        repos += data
        if len(data) < 100:
            break
        page += 1
    return repos

def main():
    mode = sys.argv[1] if len(sys.argv) > 1 else 'list'
    st, me = req(f'{API}/user')
    if st != 200:
        print('AUTH_FAIL', st, me.get('message') if isinstance(me, dict) else '')
        sys.exit(2)
    login = me.get('login')
    print('LOGIN:', login)
    repos = list_repos()
    if repos is None:
        sys.exit(3)
    targets = [r for r in repos if r['name'].lower().startswith('web-obfuscat')]
    print('TOTAL_VISIBLE:', len(repos))
    print('ALL_REPOS:', ', '.join(r['name'] for r in repos) or '(none)')
    print('TARGETS_TO_DELETE:')
    for r in targets:
        print(' -', r['full_name'], '| private:', r['private'], '| updated:', r['updated_at'])
    if mode == 'delete':
        if not targets:
            print('NOTHING_TO_DELETE')
        for r in targets:
            st2, resp = req(f"{API}/repos/{r['full_name']}", method='DELETE')
            msg = resp.get('message', '') if isinstance(resp, dict) else ''
            print('DELETE', r['full_name'], '-> HTTP', st2, msg)
        print('DONE_DELETE')
    elif mode == 'create':
        name = sys.argv[2]
        st2, resp = req(f'{API}/user/repos', method='POST', data={
            'name': name,
            'description': 'NEXUS OPTIMIZER - Multi-tool system suite (monitor, cleanup, gaming mode, tweaks, backup)',
            'private': True, 'has_issues': True, 'has_wiki': False,
        })
        print('CREATE', name, '-> HTTP', st2, resp.get('full_name', resp.get('message', '')))
    elif mode == 'info':
        st2, resp = req(f"{API}/repos/{login}/{sys.argv[2]}")
        print('REPO_INFO', st2, resp.get('full_name', ''), resp.get('default_branch', ''), resp.get('message', ''))

if __name__ == '__main__':
    main()
