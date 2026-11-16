# Task 8-b — Bug Fixer Agent X-2

## Fixed (all 14 bugs assigned)
1. **store.ts `applyGaming`** — checks `r.ok` before parse, treats `data.error`/mismatch as failure, sets `gaming` only on real success; failure path returns false + toast 'Gaming Mode chưa được áp dụng'.
2. **store.ts `hydrate`** — `gaming` only written from response when `gr.ok`; previous value kept otherwise.
3. **overview-panel `cleanAll`** — `!r.ok || data.error` throws (message surfaced in toast); success toast uses `formatBytes()` from '@/lib/format' (fixes 2GB→"2048.0 MB" bug).
4. **use-stats.ts** — self-scheduling setTimeout chain (schedule in `finally`, clear in cleanup); no overlapping polls; history append order preserved.
5. **page.tsx customBgUrl** — validated client-side (http://, https://, or `/`; quotes/backslashes rejected), embedded as `url("${encodeURI(url)}")`; invalid URL falls back to default gradient.
6. **globals.css** — added `--radius-2xl/-3xl` tokens to `@theme inline` so Settings radius slider drives `rounded-2xl/3xl` cards.
7. **Gaming shell surfaces** — `--surface`/`--surface-2` vars defined (:root #111117/#0d0d12; gaming #0a0a12/#050508); sidebar, mobile Sheet use `bg-[color:var(--surface)]`, topbar uses color-mix of `--surface-2` 80%; BackgroundLayer has gaming branch (black+purple gradient) reading `gaming` from store.
8. **overview TX color** — `text-sky-300` → inline `var(--accent-2)`.
9. **processes-panel** — kill button `aria-label`+title `Dừng tiến trình {name}`; CPU colors unified via exported `thresholdColor()` from gauge.tsx (60/85 thresholds); loading = 3 Skeleton rows.
10. **screenshot-panel** — delete `aria-label`/title `Xóa ảnh {file}` (+ download anchor label); action bar `opacity-100 lg:opacity-0 lg:group-hover:opacity-100` (touch reachable).
11. **settings-panel radius slider** — local `radiusPx` state; onValueChange = local + 400ms debounced save (useRef timer); onValueCommit persists immediately; external changes sync via render-time prev-state pattern (passes react-hooks/set-state-in-effect rule).
12. **sidebar `sheetMode` prop** — mobile instance hides "Thu gọn", shows "Đóng điều hướng" (X icon); page passes `sheetMode` only for the Sheet instance.
13. **API health badge** — store gains `apiHealthy`/`setApiHealthy`; use-stats sets true on success, false after 2 consecutive failures; Topbar badge emerald "Hoạt động" / rose "Mất kết nối" (aria-live).
14. **live-chart tooltip** (assigned via bug 14) — `#18181bee` → `color-mix(in srgb, var(--popover) 92%, transparent)`; copy: "Bộ công cụ đa năng", badge "BẬT", column "Người dùng".

## Verification
- `bunx tsc --noEmit`: **0 errors in my files** (remaining: examples/skills pre-existing; `src/lib/sysinfo.ts` rx/tx errors appeared mid-run from a parallel agent editing that file — not mine).
- `bunx eslint` on all 11 owned files + live-chart: 0 errors, 0 warnings (removed 2 stale eslint-disable directives).
- curl `/` → 200; POST /api/gaming on/off → 200 `enabled` echoes true/false; POST /api/cleanup → 200; dev.log clean.
- Page renders new copy ("Bộ công cụ đa năng", "Hoạt động" badge).

## Notes
- Topbar translucency preserved via `color-mix(in srgb, var(--surface-2) 80%, transparent)` inline style (Tailwind slash-opacity on arbitrary var is unreliable in v4).
- Gaming get-API returns 200 even on server error with `enabled:false`; that contract is unchanged server-side — hydrate now trusts only `gr.ok`.
