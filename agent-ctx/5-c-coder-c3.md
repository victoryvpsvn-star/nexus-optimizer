# Task 5-c — Coder Agent C-3: Module "Sao lưu" (Backup)

## Files written (only my 4 owned files)
1. `scripts/s3_sidecar.py` — Python CLI sidecar: ops `upload|list|delete|presign|download`, one-line JSON stdout, creds regex identical to s3_check.py, keyset index from `scripts/.s3_keyset` (fallback 1), prefix `nexus-backups/`, boto3 path-style, cap 200 items, credentials redacted from any error, logging disabled.
2. `src/lib/backup.ts` — createBackup (tar.gz excludes node_modules/.next/backups/.git/upload; NEVER .env), listLocal/listBucket, uploadToBucket (600s timeout), deleteLocal (path guard), deleteBucketObject, presignFor/presignKey, restoreFromBucket (/tmp staging + safe extract).
3. `src/app/api/backups/route.ts` — GET (BackupListResponse + totalLocalBytes), POST {name}, PUT {upload|presign|restore}, DELETE ?type=local|bucket, Vietnamese errors, no credentials in responses.
4. `src/components/modules/backup-panel.tsx` — named + default export `BackupPanel`; hero card (input + accent button + bucket status/local/bucket size badges), lg:grid-cols-2 tables (local: upload/download/delete; bucket: download/restore/delete via AlertDialog), GitHub Actions card with "Mở GitHub Actions" link, sonner toasts, empty states, thin-scroll max-h-96.

## Verification results
- Sidecar standalone: `list` → {"ok":true,"items":[]} (bucket clean). Full round-trip tested upload/list/presign/download/delete — all ok, download byte-match. No secret ever printed.
- API E2E via curl: GET 200, POST (slug "Nexus C3 Test!! backup" → `Nexus-C3-Test-backup-<ts>.tar.gz`, 362KB), PUT upload ok, presign(id+key) ok, DELETE local+bucket ok, restore ok.
- `bunx tsc --noEmit`: 0 errors in my files (remaining 4 errors are in examples/, skills/, tweaks-panel — other agents' files).

## Hardening added after testing
- Sidecar download: fallback to `get_object` streaming when HeadObject transiently 403s on this gateway.
- Restore extract also excludes `db`/`*.db-wal`/`*.db-shm` so the live SQLite is never clobbered.

## WARNING for next agents / driver
My E2E restore test (before hardening) extracted the archive's `db/custom.db` over the live file; the long-running `next dev` Prisma engine now returns "attempt to write a readonly database" on WRITES (reads fine, DB file itself is healthy — verified via fresh `node` PrismaClient write). A dev-server restart fully heals it. It cannot self-heal and I am not allowed to restart it. Restore can no longer cause this (db excluded from extraction).
