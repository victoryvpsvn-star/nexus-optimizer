#!/usr/bin/env python3
"""S3 sidecar cho module Sao lưu (NEXUS OPTIMIZER).

CLI: python3 scripts/s3_sidecar.py <op> [args]
  upload   <localPath> <key>
  list
  delete   <key>
  presign  <key> [expiresSec]
  download <key> <localPath>

Chuẩn đầu ra: ĐÚNG MỘT dòng JSON duy nhất trên stdout.
Thông tin xác thực được đọc tại runtime từ upload/work.txt —
TUYỆT ĐỐI không in key/secret/token ra bất kỳ đâu (stdout/stderr/log).
Mọi lỗi được bọc trong {"ok": false, "error": ...} (đã redact credential).
"""
import json
import logging
import pathlib
import os
import re
import sys

# Chặn mọi log (boto3/botocore ghi ra stderr theo mặc định, nhưng chặn chắc chắn)
logging.disable(logging.CRITICAL)

ENDPOINT = 'https://u3-asia.altare.global'
REGION = 'asia'
BUCKET = 'vic'
PREFIX = 'nexus-backups/'
WORK_FILE = pathlib.Path(
    os.environ.get('NEXUS_WORK_FILE', '/home/z/my-project/upload/work.txt')
)
KEYSET_FILE = pathlib.Path(
    os.environ.get('NEXUS_KEYSET_FILE', '/home/z/my-project/scripts/.s3_keyset')
)
MAX_ITEMS = 200  # an toàn hiệu năng với bucket tới 30GB (paginate + cap)


def load_credentials():
    """Trả về (access_key_id, secret_access_key) theo index trong .s3_keyset (fallback 1)."""
    txt = WORK_FILE.read_text(errors='ignore')
    # Regex giống hệt s3_check.py (đã kiểm chứng trên work.txt)
    pairs = re.findall(r'(GK[a-z0-9]+)\n+Copy\s*\n+Secret Access Key\s*\n+([0-9a-f]{64})', txt)
    if not pairs:
        # fallback: ghép lỏng hơn khi format lệch dòng
        ids = re.findall(r'(GK[a-z0-9]{12,})', txt)
        secs = re.findall(r'\n([0-9a-f]{64})\n', txt)
        pairs = list(zip(ids, secs)) if len(ids) == len(secs) else []
    if not pairs:
        raise RuntimeError('Khong tim thay thong tin xac thuc S3 trong upload/work.txt')
    idx = 1
    try:
        raw = KEYSET_FILE.read_text().strip()
        idx = int(raw) if raw else 1
    except Exception:
        idx = 1
    if idx < 1 or idx > len(pairs):
        idx = 1
    ak, sk = pairs[idx - 1]
    return ak, sk


def get_client():
    import boto3
    from botocore.config import Config

    ak, sk = load_credentials()
    return boto3.client(
        's3',
        endpoint_url=ENDPOINT,
        region_name=REGION,
        aws_access_key_id=ak,
        aws_secret_access_key=sk,
        config=Config(
            s3={'addressing_style': 'path'},
            retries={'max_attempts': 2},
            connect_timeout=10,
            read_timeout=120,
        ),
    )


def sanitize_error(msg, secrets):
    """Redact credential + bỏ xuống dòng để stdout luôn là 1 dòng JSON."""
    out = str(msg)
    for s in secrets:
        if s:
            out = out.replace(s, '[REDACTED]')
    out = out.replace('\r', ' ').replace('\n', ' ')
    return out[:300]


def emit(payload, secrets=()):
    """In đúng một dòng JSON rồi thoát."""
    payload = dict(payload)
    if not payload.get('ok') and payload.get('error'):
        payload['error'] = sanitize_error(payload['error'], secrets)
    sys.stdout.write(json.dumps(payload, ensure_ascii=False) + '\n')
    sys.stdout.flush()
    sys.exit(0)


def main():
    argv = sys.argv[1:]
    secrets = []
    try:
        secrets = list(load_credentials())
    except Exception as e:
        emit({'ok': False, 'error': f'{type(e).__name__}: {e}'})

    if not argv:
        emit({'ok': False, 'error': 'Thieu tham so op (upload/list/delete/presign/download)'}, secrets)
    op = argv[0]

    try:
        s3 = get_client()
        if op == 'upload':
            if len(argv) < 3:
                emit({'ok': False, 'error': 'upload can: <localPath> <key>'}, secrets)
            local, key = argv[1], argv[2]
            size = pathlib.Path(local).stat().st_size
            s3.upload_file(local, BUCKET, key)
            emit({'ok': True, 'key': key, 'sizeBytes': size}, secrets)
        elif op == 'list':
            items = []
            paginator = s3.get_paginator('list_objects_v2')
            for page in paginator.paginate(Bucket=BUCKET, Prefix=PREFIX):
                for obj in page.get('Contents', []):
                    items.append({
                        'key': obj['Key'],
                        'sizeBytes': int(obj.get('Size', 0)),
                        'lastModified': obj['LastModified'].isoformat(),
                    })
                    if len(items) >= MAX_ITEMS:
                        break
                if len(items) >= MAX_ITEMS:
                    break
            items.sort(key=lambda x: x['lastModified'], reverse=True)
            emit({'ok': True, 'items': items}, secrets)
        elif op == 'delete':
            if len(argv) < 2:
                emit({'ok': False, 'error': 'delete can: <key>'}, secrets)
            s3.delete_object(Bucket=BUCKET, Key=argv[1])
            emit({'ok': True}, secrets)
        elif op == 'presign':
            if len(argv) < 2:
                emit({'ok': False, 'error': 'presign can: <key> [expiresSec]'}, secrets)
            key = argv[1]
            expires = 3600
            if len(argv) > 2:
                expires = max(60, min(int(argv[2]), 604800))
            url = s3.generate_presigned_url(
                'get_object',
                Params={'Bucket': BUCKET, 'Key': key},
                ExpiresIn=expires,
            )
            emit({'ok': True, 'url': url}, secrets)
        elif op == 'download':
            if len(argv) < 3:
                emit({'ok': False, 'error': 'download can: <key> <localPath>'}, secrets)
            key, local = argv[1], argv[2]
            pathlib.Path(local).parent.mkdir(parents=True, exist_ok=True)
            try:
                s3.download_file(BUCKET, key, local)
            except Exception:
                # Fallback: một số gateway trả 403 thoáng qua trên HeadObject —
                # stream trực tiếp qua get_object (đã chứng minh hoạt động).
                resp = s3.get_object(Bucket=BUCKET, Key=key)
                with open(local, 'wb') as f:
                    f.write(resp['Body'].read())
            emit({'ok': True, 'path': local}, secrets)
        else:
            emit({'ok': False, 'error': f'Lenh khong ho tro: {op}'}, secrets)
    except SystemExit:
        raise
    except Exception as e:
        emit({'ok': False, 'error': f'{type(e).__name__}: {e}'}, secrets)


if __name__ == '__main__':
    main()
