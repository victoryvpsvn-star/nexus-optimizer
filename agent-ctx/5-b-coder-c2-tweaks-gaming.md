# Task 5-b (Coder Agent C-2): Tweaks + Gaming Mode modules

## Files written (all 6 owned files)
1. `src/lib/tweaks.ts` — 18-tweak catalog (`TWEAK_ACTIONS`), ranked order 1..18 (9 recommended first), honest apply/revert via `run()`/`tryRoot()`, `sysctlRoot()` helper, upsert helper `saveState()` (truncates lastResult to 220 chars). Exports `applyTweakById()`, `revertTweakById()`, `getTweaks()` (catalog merged with TweakState, sorted by order).
2. `src/app/api/tweaks/route.ts` — GET `{tweaks}`; POST zod `{ids[], action: apply|revert}`, sequential, per-item try/catch → `{results: TweakRunResult[]}`.
3. `src/components/modules/tweaks-panel.tsx` — toolbar (Select category filter "Tất cả" + 5 categories, "Áp dụng bộ khuyến nghị" accent button, "Áp dụng/Khôi phục đã chọn"), ranked rows (#order mono, risk badges Thấp emerald/Trung bình amber/Cao rose outline, "Cần root" muted, applied CheckCircle2 + lastResult tooltip), per-row Checkbox + Áp dụng/Khôi phục, `thin-scroll max-h-[560px]`, sonner toasts with success/failed counts.
4. `src/lib/gaming.ts` — `setGaming()`: preset apply [drop-caches, governor-performance, swappiness-10, npm-cache-clean, tmp-clean] by reusing tweaks apply; disable reverts governor+swappiness; upserts GamingState id=1 with effects JSON. `getGamingStatus()` parses effects. Exports `GAMING_NOTE`.
5. `src/app/api/gaming/route.ts` — GET/POST; always returns `enabled` boolean (store.ts contract kept).
6. `src/components/modules/gaming-panel.tsx` — hero glass card (big Gamepad2, large Switch `data-[state=checked]:bg-[var(--accent-1)]`, ĐANG BẬT/ĐANG TẮT accent text), BẬT/TẮT button with loading, effects checklist CheckCircle2/XCircle + honest messages, amber Alert root-note banner, syncs with topbar via GET on mount + `useApp.setState` after POST.

## Verified
- `bunx tsc --noEmit`: my 6 files clean (remaining errors only in `examples/`, `skills/` — pre-existing infra, and transient cleanup-panel issues owned by other agents).
- `bun run lint`: 0 errors (2 warnings in other agents' files).
- API smoke-tested live: GET/POST /api/tweaks 200, GET/POST /api/gaming 200; root items return `success:false` with tryRoot message (honest), user items (npm/tmp clean) succeed; DB state restored to neutral after tests.

## Cross-file note
`src/app/page.tsx` (not owned by me) imports **named** exports `{ GamingPanel }` / `{ TweaksPanel }`; my spec said default export — I satisfied both by exporting named + default from both panels. No other files touched, no packages added.
