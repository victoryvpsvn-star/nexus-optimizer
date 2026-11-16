# Task 8-c — Bug Fixer Agent X-3 (gaming/tweaks/backup panels)

## Work record
- gaming-panel.tsx: toggle now checks r.ok + data.error, honest toasts, syncs useApp gaming flag, await load(); load() keeps prev status on failure, loadFailed state + "Thử lại" buttons (hero + effects card); copy fixes ("mục thành công", "bộ tinh chỉnh", "vui lòng thử lại"); aria-labels.
- tweaks-panel.tsx: runIds/runOne/load throw on !r.ok or json.error (safe JSON parse); empty-results honest warning; row buttons h-9 px-3 + aria-label/title; checkbox size-5; zinc-600 → zinc-400; title tooltip on lastResult; RISK_META verified (emerald/amber/rose outline).
- backup-panel.tsx: load throws on !r.ok/json.error, keeps prev lists; "Đã lên"→"Đã tải lên", "Chưa"→"Chưa tải lên"; 6 row buttons h-9 px-2.5 + Vietnamese aria-labels; placeholder/icons zinc-600→zinc-400; GitHub badge py-2.

## Verification
- bunx tsc --noEmit: zero new errors from owned files (pre-existing examples/skills/sysinfo only).
- bun run lint: clean. GET / → 200; /api/gaming, /api/tweaks, /api/backups → 200, shapes match.
- dev.log: compiled clean, no runtime errors.
