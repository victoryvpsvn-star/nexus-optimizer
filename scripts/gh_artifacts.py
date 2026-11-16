#!/usr/bin/env python3
"""Liệt kê + xóa artifacts GitHub để giải phóng Actions storage quota.
Token đọc runtime từ upload/work.txt — KHÔNG in token."""
import re, sys, json, urllib.request, urllib.error, pathlib

WORK = pathlib.Path('/home/z/my-project/upload/work.txt')
TOKEN = re.search(r'github_pat_[A-Za-z0-9_]+', WORK.read_text(errors='ignore')).group(0)
API = 'https://api.github.com/repos/victoryvpsvn-star/nexus-optimizer'

def req(url, method='GET'):
    r = urllib.request.Request(url, headers={
        'Authorization': f'Bearer {TOKEN}',
        'Accept': 'application/vnd.github+json',
        'User-Agent': 'nexus-ops',
    }, method=method)
    try:
        with urllib.request.urlopen(r, timeout=30) as resp:
            raw = resp.read()
            return resp.status, (json.loads(raw) if raw else {})
    except urllib.error.HTTPError as e:
        return e.code, {}

mode = sys.argv[1] if len(sys.argv) > 1 else 'list'
st, data = req(f'{API}/actions/artifacts?per_page=100')
print('ARTIFACTS HTTP', st, 'total_count:', data.get('total_count'))
total_mb = 0
for a in data.get('artifacts', []):
    mb = a.get('size_in_bytes', 0) / 1048576
    total_mb += mb
    print(f"  #{a['id']} {a['name']} {mb:.1f}MB expired={a['expired']} | {a['created_at']}")
    if mode == 'delete':
        st2, _ = req(f"{API}/actions/artifacts/{a['id']}", method='DELETE')
        print(f'    DELETE -> HTTP {st2}')
print(f'TOTAL: {total_mb:.1f}MB')
