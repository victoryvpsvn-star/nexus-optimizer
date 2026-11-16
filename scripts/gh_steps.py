#!/usr/bin/env python3
"""Liệt kê toàn bộ steps của jobs trong run + thử tải log qua run-logs zip."""
import re, sys, json, zipfile, io, urllib.request, urllib.error, pathlib

WORK = pathlib.Path('/home/z/my-project/upload/work.txt')
TOKEN = re.search(r'github_pat_[A-Za-z0-9_]+', WORK.read_text(errors='ignore')).group(0)
REPO = 'victoryvpsvn-star/nexus-optimizer'
API = f'https://api.github.com/repos/{REPO}'

def req(url, raw=False):
    r = urllib.request.Request(url, headers={
        'Authorization': f'Bearer {TOKEN}',
        'Accept': 'application/vnd.github+json',
        'User-Agent': 'nexus-ops',
    })
    try:
        with urllib.request.urlopen(r, timeout=120) as resp:
            data = resp.read()
            return resp.status, data
    except urllib.error.HTTPError as e:
        return e.code, e.read()

run_id = sys.argv[1]
st, jobs = req(f'{API}/actions/runs/{run_id}/jobs?per_page=5')
if st != 200:
    print('JOBS HTTP', st); sys.exit(1)
for job in jobs.get('jobs', []):
    print(f"JOB: {job['name']} -> {job['status']}/{job.get('conclusion')}")
    for s in job.get('steps', []):
        print(f"   [{s.get('conclusion'):>9}] #{s['number']} {s['name']}")

# Thử tải zip log toàn run
st2, zdata = req(f'{API}/actions/runs/{run_id}/logs')
print('RUN_LOGS_ZIP HTTP', st2, 'bytes', len(zdata))
if st2 == 200 and zdata[:2] == b'PK':
    zf = zipfile.ZipFile(io.BytesIO(zdata))
    for name in zf.namelist():
        if 'artifact' in name.lower() or 'Upload' in name:
            text = zf.read(name).decode('utf-8', errors='replace')
            print(f'----- {name} (tail 4000) -----')
            print(text[-4000:])
