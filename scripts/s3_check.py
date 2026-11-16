#!/usr/bin/env python3
"""Discover working S3 credential set (from upload/work.txt) and bucket name. Never prints secrets."""
import re, pathlib, sys

txt = pathlib.Path('/home/z/my-project/upload/work.txt').read_text(errors='ignore')
pairs = re.findall(r'(GK[a-z0-9]+)\n+Copy\s*\n+Secret Access Key\s*\n+([0-9a-f]{64})', txt)
if not pairs:
    # fallback: looser pairing
    ids = re.findall(r'(GK[a-z0-9]{12,})', txt)
    secs = re.findall(r'\n([0-9a-f]{64})\n', txt)
    pairs = list(zip(ids, secs)) if len(ids) == len(secs) else []
print('KEYSETS_FOUND:', len(pairs))
if not pairs:
    sys.exit(1)

import boto3
from botocore.config import Config

ENDPOINT = 'https://u3-asia.altare.global'
REGION = 'asia'

def try_key(i, ak, sk):
    s3 = boto3.client('s3', endpoint_url=ENDPOINT, region_name=REGION,
                      aws_access_key_id=ak, aws_secret_access_key=sk,
                      config=Config(s3={'addressing_style': 'path'},
                                    retries={'max_attempts': 2},
                                    connect_timeout=10, read_timeout=25))
    try:
        resp = s3.list_buckets()
        names = [b['Name'] for b in resp.get('Buckets', [])]
        return s3, names
    except Exception as e:
        print(f'KEYSET#{i} FAIL: {type(e).__name__}')
        return None, None

for i, (ak, sk) in enumerate(pairs, 1):
    s3, names = try_key(i, ak, sk)
    if s3 is not None:
        print(f'KEYSET#{i} OK -> BUCKETS: {names}')
        # total size hint: list objects of first bucket
        for b in names:
            try:
                r = s3.list_objects_v2(Bucket=b, MaxKeys=5)
                print(f'  bucket {b}: objects={r.get("KeyCount", 0)}')
            except Exception as e:
                print(f'  bucket {b}: list_fail {type(e).__name__}')
        # write the chosen index for other scripts (no secret written)
        pathlib.Path('/home/z/my-project/scripts/.s3_keyset').write_text(str(i))
        break
