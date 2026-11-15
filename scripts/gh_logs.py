#!/usr/bin/env python3
"""Lấy log các job thất bại của workflow run — token KHÔNG được in."""
import re, sys, json, urllib.request, urllib.error, pathlib

WORK = pathlib.Path('/home/z/my-project/upload/work.txt')
TOKEN = re.search(r'github_pat_[A-Za-z0-9_]+', WORK.read_text(errors='ignore')).group(0)
REPO = 'victoryvpsvn-star/nexus-optimizer'
API = f'https://api.github.com/repos/{REPO}'

def req(url, method='GET', raw=False):
    r = urllib.request.Request(url, headers={
        'Authorization': f'Bearer {TOKEN}',
        'Accept': 'application/vnd.github+json',
        'User-Agent': 'nexus-ops',
    }, method=method)
    try:
        with urllib.request.urlopen(r, timeout=60) as resp:
            data = resp.read()
            if raw:
                return resp.status, data
            return resp.status, (json.loads(data) if data else {})
    except urllib.error.HTTPError as e:
        return e.code, (e.read() if raw else {})

run_id = sys.argv[1]
st, jobs = req(f'{API}/actions/runs/{run_id}/jobs?per_page=5')
for job in jobs.get('jobs', []):
    print(f"JOB: {job['name']} -> {job['status']}/{job.get('conclusion')}")
    for s in job.get('steps', []):
        if s.get('conclusion') and s['conclusion'] not in ('success', 'skipped', 'neutral'):
            print(f"  FAILED STEP: {s['name']} [{s['conclusion']}]")
    if job.get('conclusion') == 'failure':
        st2, log = req(job['url'] + '/logs', raw=True)
        print(f"  LOG HTTP {st2}, bytes={len(log)}")
        if st2 == 200 and log:
            text = log.decode('utf-8', errors='replace')
            # In phần cuối của log (thường lỗi nằm cuối) — tối đa 6000 ký tự
            tail = text[-6000:]
            print('----- LOG TAIL -----')
            print(tail)
