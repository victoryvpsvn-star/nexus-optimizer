# Task 8-a — Bug Fixer Agent X-1 — Work Record

## Files owned & modified
- src/lib/sysinfo.ts
- src/lib/tweaks.ts
- src/lib/backup.ts
- src/app/api/{tweaks,gaming,backups,cleanup,screenshot,processes,settings}/route.ts
- .gitignore (append-only)

## Fixes applied
1. **sysinfo.ts listProcesses**: ps cols reordered to `pid,user,pcpu,pmem,rss,comm`; name = join(parts.slice(5)) so comm spaces ("next-server (v...") no longer shift stats.
2. **sysinfo.ts net rate**: removed module-level `lastNet`; new `netRate()` samples twice 150ms apart inside getStats and computes rate per-request (race-free).
3. **backup.ts createBackup**: removed `db` + nonexistent `.env.example` from include list; added `--exclude=.env*`; dropped `2>/dev/null || true`; checks `r.ok`, then verifies with `tar -tzf`; deletes corrupt file + throws Vietnamese error.
4. **backup.ts restoreFromBucket**: random crypto temp name; `tar -tzf` integrity + member audit (rejects `/`-prefixed or `..` members with ok:false VN message); checks extract `r.ok`; adds excludes `.env*`, `node_modules*`, `upload*`; NoSuchKey→NotFoundError(404).
5. **tweaks.ts governor**: orig file written via fs with mode 0600, only if `/^[a-z0-9_-]+$/` matches; revert validates stored value, falls back to scaling_available_governors (schedutil→powersave→schedutil), never interpolates unvalidated text.
6. **api/tweaks POST**: cap 12 ids (400 "Tối đa 12 tinh chỉnh mỗi lần áp dụng"), 90s wall-clock deadline → remaining ids get "Bỏ qua do vượt thời gian xử lý".
7. **api/processes DELETE**: rejects pid<=1, pid===process.pid, pid===ppid with distinct VN 400s.
8. **Malformed JSON**: `req.json().catch(()=>null)` → 400 "Dữ liệu không hợp lệ" in tweaks/gaming/backups/cleanup/screenshot/settings PUT.
9. **api/screenshot POST**: content-length >16MB → 413 before json(); decoded buf.length >15MB → 413; filename `shot-<ts>-<randomBytes(4)hex>.png`; DELETE regex accepts old+new patterns.
10. **api/settings**: GET sanitizes per-field (enum whitelists, radius 0.5–1.5 finite, customBgUrl string ≤500) with per-field DEFAULT fallback; PUT validates parsed JSON.
11. **api/backups**: DELETE local id must be integer>0 (400); presign id>0 + key prefix `nexus-backups/` checks (400); unknown id/key → 404 via NotFoundError; restore ok:false → 400 with error; bucket delete prefix check (400).
12. **api/cleanup**: console.error added in GET + POST catches.
13. **.gitignore**: appended `.env`, `.env.*`, `upload/`, `backups/`, `db/`, `public/screenshots/`.

## Verification (all pass)
- `bunx tsc --noEmit`: zero errors from my files (only pre-existing examples/ + skills/ errors). `bun run lint` clean.
- GET /api/processes 200 — `next-server (v1` row: cpu 1.8, rss 1355.5MB, sane.
- GET /api/settings, /api/backups, /api/cleanup → 200.
- PUT /api/settings valid → 200; radius 9 → 400; malformed → 400. Settings restored to original after tests.
- POST /api/tweaks malformed → 400; 13 ids → 400 "Tối đa 12...".
- DELETE /api/processes pid=1/self(5083)/ppid(5068) → 400; unknown pid → 200 ESRCH path.
- POST /api/backups → created backup (120 entries, NO db/.env in tar), deleted OK.
- PUT /api/backups presign unknown id → 404; malformed → 400; DELETE id=0 → 400.
- POST /api/screenshot oversized CL → 413; small png → new filename pattern saved+deleted OK.
- GET /api/stats net fields present. dev.log tail: no runtime errors.

## Not fixed / notes
- Could not live-test malicious path-traversal restore (would require planting hostile object in bucket) — logic verified by code inspection + tar -tzf flow exercised via createBackup.
