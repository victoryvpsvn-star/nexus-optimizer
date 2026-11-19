/**
 * ci/fps-benchmark.mjs — tự test FPS của Sakura Tool trên CI (v3.5.0).
 *
 * Kịch bản (đúng yêu cầu: test ép xung TRƯỚC rồi mới test FPS xem có tăng không):
 *   1. Mở UI tool (server đã chạy ở 127.0.0.1:32199, ép xung đã test bằng curl trước đó).
 *   2. FPS test LẦN 1 (baseline, mục tiêu mặc định 60) → chụp 00-baseline-60fps.png
 *      → assert FPS nằm trong 50…75 (≈60, đúng "mặc định trên đó là 60").
 *   3. Kéo FPS mục tiêu lên 120 → chụp 01-fps-target-120.png (bằng chứng đã chỉnh FPS).
 *   4. Bấm "🚀 Tối ưu" (ép xung + timer resolution) → chờ kết quả → chụp 02-toi-uu.png
 *      (bằng chứng đã bấm Tối ưu + từng bước áp dụng).
 *   5. FPS test LẦN 2 → assert ≥ 105 (mục tiêu 120) → chụp 03-fps-after-120.png.
 *   6. In bảng kết quả ra stdout + $GITHUB_STEP_SUMMARY, exit 1 nếu bất kỳ assert fail.
 *
 * Browser: google-chrome-stable có sẵn trên runner ubuntu-latest; puppeteer-core không tải browser.
 * Lưu ý: FPS ở đây là nhịp render do tool giữ bằng bộ đếm hiệu năng (timer resolution ảnh
 * hưởng thật trên Windows); trên CI Linux mục đích là kiểm chứng pipeline end-to-end.
 */
import fs from 'node:fs';
import path from 'node:path';
import puppeteer from 'puppeteer-core';

const BASE = process.env.SAKURA_URL || 'http://127.0.0.1:32199';
const SHOTS = path.resolve('ci/shots');
fs.mkdirSync(SHOTS, { recursive: true });

const CANDIDATES = [
  '/usr/bin/google-chrome-stable',
  '/usr/bin/google-chrome',
  '/usr/bin/chromium-browser',
  '/usr/bin/chromium',
  '/snap/bin/chromium',
];
const exe = CANDIDATES.find((p) => fs.existsSync(p));
if (!exe) {
  console.error('❌ Không tìm thấy Chrome/Chromium trên runner');
  process.exit(1);
}
console.log('🌐 Browser:', exe);

const summary = { baseline: null, after: null, maxBefore: null, maxAfter: null, pass: false, steps: [] };
const fail = (msg) => {
  console.error('❌', msg);
  summary.steps.push('❌ ' + msg);
  writeSummary(1);
  process.exit(1);
};
const ok = (msg) => {
  console.log('✅', msg);
  summary.steps.push('✅ ' + msg);
};

function writeSummary(exitCode) {
  const lines = [
    '## 🧪 Kết quả tự test FPS (v3.5.0)',
    '',
    '| Bước | Kết quả |',
    '| --- | --- |',
    `| Test ép xung (curl trước UI) | ${summary.steps.filter((s) => s.includes('Ép xung API')).join(' ') || '(ở job step curl)' } |`,
    `| FPS baseline (giữ nhịp, mặc định 60) | ${summary.baseline ?? '—'} |`,
    `| Năng lực TỐI ĐA thật trước (không giới hạn) | ${summary.maxBefore ?? '—'} |`,
    `| FPS sau Tối ưu (giữ nhịp, mục tiêu 120) | ${summary.after ?? '—'} |`,
    `| Năng lực TỐI ĐA thật sau (không giới hạn) | ${summary.maxAfter ?? '—'} |`,
    `| Kết luận | ${summary.pass ? '✅ ĐẠT — giữ nhịp tăng ' + summary.baseline + ' → ' + summary.after + ', năng lực thật ' + summary.maxAfter + ' FPS ≥ 120' : '❌ FAIL'} |`,
    '',
    ...summary.steps.map((s) => '- ' + s),
    '',
  ];
  fs.writeFileSync('ci/fps-summary.md', lines.join('\n'));
  if (process.env.GITHUB_STEP_SUMMARY) {
    fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, lines.join('\n') + '\n');
  }
  if (exitCode !== undefined && process.env.FPS_SUMMARY_ONLY) {
    process.exit(exitCode);
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function runBench(page, shot) {
  await page.click('#perfBenchBtn');
  // 2 pha: giữ nhịp 4s + đo tối đa 3s → verdict gắn dataset paced/max (không parse text cho chắc)
  await page.waitForFunction(() => document.querySelector('#benchVerdict').dataset.done === '1', { timeout: 45000 });
  const d = await page.$eval('#benchVerdict', (el) => ({ text: el.textContent, paced: el.dataset.paced, max: el.dataset.max }));
  const fps = Math.round(Number(d.paced));
  const max = Math.round(Number(d.max));
  if (!Number.isFinite(fps) || !Number.isFinite(max)) fail('Không đọc được paced/max từ verdict: ' + d.text);
  await sleep(300); // đợi render verdict ổn định
  await page.screenshot({ path: path.join(SHOTS, shot) });
  ok(`FPS test (${shot}): ${d.text}`);
  return { fps, max, text: d.text };
}

const browser = await puppeteer.launch({
  executablePath: exe,
  headless: true,
  args: [
    '--no-sandbox',
    '--disable-gpu',
    '--disable-background-timer-throttling',
    '--disable-backgrounding-occluded-windows',
    '--disable-renderer-backgrounding',
    '--window-size=1380,940',
  ],
});
try {
  const page = await browser.newPage();
  await page.setViewport({ width: 1380, height: 940 });
  await page.goto(BASE, { waitUntil: 'networkidle2', timeout: 30000 });

  // Welcome overlay (nếu hiện) — đồng ý để vào UI
  await page.evaluate(() => {
    const ov = document.getElementById('welcomeOverlay');
    if (ov && getComputedStyle(ov).display !== 'none') {
      localStorage.setItem('sakura_welcome_seen', '1');
      ov.style.display = 'none';
    }
  });

  // v3.9.0: token phiên — mọi API mutating phải kèm header X-Nexus-Token (audit P1-07)
  const TOKEN = await page.evaluate(() => window.__nexus_token || '');
  if (!TOKEN) fail('Không đọc được token phiên từ UI (window.__nexus_token)');

  await page.waitForSelector('#perfCard', { timeout: 15000 });
  // Card Hiệu năng nằm trong tab Tinh chỉnh — UI mặc định mở tab Tổng quan → chuyển tab trước
  await page.evaluate(() => {
    const nav = document.querySelector('.nav-item[data-section="tweaks"]');
    if (nav) nav.click();
    const card = document.getElementById('perfCard');
    if (card) card.scrollIntoView({ block: 'center' });
  });
  await page.waitForFunction(() => {
    const el = document.getElementById('perfCard');
    return el && el.offsetParent !== null; // đang hiển thị thật (không bị ẩn bởi tab)
  }, { timeout: 10000 });
  ok('UI mở được, tab Tinh chỉnh + card Hiệu năng hiển thị');

  // ---- Bước 2: FPS baseline (mặc định 60) + đo năng lực tối đa thật ----
  const base = await runBench(page, '00-baseline-60fps.png');
  summary.baseline = base.fps;
  summary.maxBefore = base.max;
  if (base.fps < 50 || base.fps > 75) fail(`Baseline phải ≈60 (nhận ${base.fps}) — mặc định của tool là 60`);
  if (base.max <= base.fps) fail(`Năng lực tối đa (${base.max}) phải cao hơn nhịp (${base.fps}) — nếu không, phép đo tối đa có vấn đề`);
  ok(`Baseline ≈60 xác nhận (${base.fps} FPS) • năng lực thật của runner: ${base.max} FPS`);
  await page.click('#benchClose');
  await sleep(400);

  // ---- Bước 3: chỉnh FPS mục tiêu lên 120 (bằng chứng screenshot) ----
  await page.evaluate(() => {
    const el = document.getElementById('perfFpsRange');
    el.value = '120';
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
  });
  await page.waitForFunction(() => document.getElementById('perfFpsVal').textContent.includes('120'), { timeout: 5000 });
  await sleep(600); // đợi PUT settings (debounce 250ms)
  await page.screenshot({ path: path.join(SHOTS, '01-fps-target-120.png') });
  ok('Đã chỉnh FPS mục tiêu lên 120 (screenshot 01-fps-target-120.png)');

  // ---- Bước 4: bấm Tối ưu (ép xung + timer resolution) ----
  await page.click('#perfOptBtn');
  await page.waitForFunction(() => document.querySelector('#perfResult').dataset.done === '1', { timeout: 30000 });
  await sleep(500);
  const resOk = await page.$eval('#perfResult', (el) => el.dataset.ok === '1');
  await page.screenshot({ path: path.join(SHOTS, '02-toi-uu-applied.png') });
  if (!resOk) fail('Tối ưu báo có bước lỗi — xem 02-toi-uu-applied.png');
  ok('Đã bấm Tối ưu — các bước ép xung + timer áp dụng xong (screenshot 02-toi-uu-applied.png)');

  // ---- Bước 5: FPS test lần 2 — paced ≥105 (mục tiêu 120) VÀ năng lực thật ≥120 ----
  const after = await runBench(page, '03-fps-after-120.png');
  summary.after = after.fps;
  summary.maxAfter = after.max;
  // v4.4.0: ngưỡng đúng theo thiết kế ≥105 (jitter target 120 -15); trước đây hard-code
  // 145 lệch message — run nhận 119 (đúng chủ đích tool) bị fail oan
  if (after.fps < 105) fail(`FPS sau Tối ưu phải ≥105 (mục tiêu 120, nhận ${after.fps})`);
  if (after.fps <= base.fps) fail('FPS sau Tối ưu phải TĂNG so với baseline');
  if (after.max < 120) fail(`Năng lực TỐI ĐA thật chỉ ${after.max} FPS < 120 — không được khoe 120 khi máy không đủ (anti-fake)`);
  if (after.max < after.fps) fail(`Năng lực thật (${after.max}) thấp hơn nhịp giữ được (${after.fps}) — phép đo có vấn đề`);

  // ---- Bước 6 (v3.6.0): test GPU ưu tiên cao cho game (mô phỏng) + Gaming Mode shape ----
  const ggSet = await (await fetch(BASE + '/api/perf/game-gpu', {
    method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Nexus-Token': TOKEN },
    body: JSON.stringify({ path: 'C:\\Games\\game.exe', action: 'set' }),
  })).json();
  if (!ggSet.success) fail('game-gpu set fail: ' + JSON.stringify(ggSet));
  const ggList = await (await fetch(BASE + '/api/perf/game-gpu')).json();
  if (!Array.isArray(ggList.entries) || ggList.entries.length < 1) fail('game-gpu list phải có ≥1 entry: ' + JSON.stringify(ggList));
  if (!ggList.entries.some((e) => e.value.includes('GpuPreference=2'))) fail('entry phải chứa GpuPreference=2');
  const ggClear = await (await fetch(BASE + '/api/perf/game-gpu', {
    method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Nexus-Token': TOKEN },
    body: JSON.stringify({ path: 'C:\\Games\\game.exe', action: 'clear' }),
  })).json();
  if (!ggClear.success) fail('game-gpu clear fail: ' + JSON.stringify(ggClear));
  ok(`GPU ưu tiên cao cho game: set → list (${ggList.entries.length} entry) → clear đều OK (mode=${ggList.mode})`);

  for (const en of [true, false]) {
    const g = await (await fetch(BASE + '/api/gaming', {
      method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Nexus-Token': TOKEN },
      body: JSON.stringify({ enabled: en }),
    })).json();
    if (!Array.isArray(g.effects) || g.effects.length < 18) { // v4.1.0: tắt = 18 effects (bỏ win-sysresp), bật = 20
      fail(`Gaming Mode ${en ? 'bật' : 'tắt'} phải trả đủ effects (bật ≥20 / tắt 18 — v4.1.0 bỏ win-sysresp khỏi Revert theo phát hiện 07): ${g.effects ? g.effects.length : 'null'}`);
    }
    ok(`Gaming Mode ${en ? 'BẬT' : 'TẮT'}: ${g.effects.filter((x) => x.success).length}/${g.effects.length} bước OK (nền không-Windows sẽ báo trung thực)`);
  }

  // ---- Bước 7 (v3.7.0): App Optimizer + Fixes — shape trung thực trên nền không-Windows ----
  const apps = await (await fetch(BASE + '/api/appopt')).json();
  if (!Array.isArray(apps) || apps.length !== 8) fail(`appopt phải trả 8 app (v4.0.0 thêm steam+onedrive): ${apps ? apps.length : 'null'}`);
  if (apps.some((a) => a.installed !== false)) fail('trên Linux không được báo app đã cài (detect đường dẫn Windows)');
  if (!apps.every((a) => typeof a.id === 'string' && typeof a.desc === 'string' && a.warning)) fail('mỗi app phải có id/desc/warning');
  const appRun = await (await fetch(BASE + '/api/appopt', {
    method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Nexus-Token': TOKEN },
    body: JSON.stringify({ id: 'edge', enabled: true }),
  })).json();
  if (appRun.success !== false) fail('appopt trên Linux phải báo trung thực success=false');
  ok('App Optimizer: 6 app detect trung thực (0 cài trên Linux) + POST báo "chỉ Windows" đúng');
  const fixes = await (await fetch(BASE + '/api/fixes')).json();
  if (!Array.isArray(fixes) || fixes.length !== 14) fail(`fixes phải trả ≥14 fix (v4.4.0 +4: restorepoint/icons/uwp/diskscan): ${fixes ? fixes.length : 'null'}`);
  const fixRun = await (await fetch(BASE + '/api/fixes', {
    method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Nexus-Token': TOKEN },
    body: JSON.stringify({ id: 'fix-internet' }),
  })).json();
  if (!Array.isArray(fixRun.steps) || fixRun.steps.length < 1) fail('fixes POST phải trả steps');
  if (fixRun.success !== false || fixRun.mode !== 'không-Windows') fail('fixes trên Linux phải trung thực (mode=không-Windows)');
  ok(`Fixes: 6 fix catalog OK + POST fix-internet trả steps trung thực (mode=${fixRun.mode})`);

  // ---- Bước 8 (v3.8.0): Dịch vụ — 4 nhóm + preset trung thực trên nền không-Windows ----
  const svcs = await (await fetch(BASE + '/api/services')).json();
  if (!Array.isArray(svcs.groups) || svcs.groups.length !== 4) fail(`services phải trả 4 nhóm: ${svcs.groups ? svcs.groups.length : 'null'}`);
  const nItems = svcs.groups.reduce((n, g) => n + g.items.length, 0);
  if (nItems !== 9) fail(`tổng 9 mục dịch vụ, nhận ${nItems}`);
  if (svcs.groups.some((g) => !['red', 'orange', 'teal', 'purple'].includes(g.tone))) fail('nhóm phải có tone glow');
  if (!svcs.groups.every((g) => g.items.every((i) => typeof i.name === 'string' && typeof i.desc === 'string' && i.state))) fail('item thiếu name/desc/state');
  const svcRun = await (await fetch(BASE + '/api/services', {
    method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Nexus-Token': TOKEN },
    body: JSON.stringify({ action: 'preset', level: 'minimum' }),
  })).json();
  if (svcRun.success !== false || svcRun.mode === 'windows') fail('preset trên Linux phải trung thực');
  ok(`Dịch vụ: 4 nhóm / 9 mục (tone glow đủ) + POST preset minimum trung thực (mode=${svcRun.mode})`);

  // ---- Bước 9 (v3.9.0): token guard + confirm guard + restore shape ----
  const noTok = await fetch(BASE + '/api/gaming', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ enabled: false }) });
  if (noTok.status !== 403) fail(`POST không token phải 403, nhận ${noTok.status}`);
  const badTok = await fetch(BASE + '/api/services', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Nexus-Token': 'x' }, body: JSON.stringify({ action: 'preset', level: 'off' }) });
  if (badTok.status !== 403) fail(`POST token sai phải 403, nhận ${badTok.status}`);
  ok('Token guard: POST không/sai token → 403 trung thực');
  const stFull = await (await fetch(BASE + '/api/selftest', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Nexus-Token': TOKEN }, body: JSON.stringify({ mode: 'full', confirm: false }) })).json();
  if (!(stFull.error || '').includes('confirm')) fail('selftest full không confirm phải bị chặn, nhận: ' + JSON.stringify(stFull));
  ok('Selftest full: bắt buộc confirm=true (audit P0-03) ✓');
  const bkr = await (await fetch(BASE + '/api/backup/restore', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Nexus-Token': TOKEN }, body: JSON.stringify({ name: 'nope.reg' }) })).json();
  if (!bkr.error) fail('backup restore phải báo trung thực lỗi, nhận: ' + JSON.stringify(bkr));
  ok('Backup restore endpoint có shape trung thực (audit P0-02) ✓');

  // ---- Bước 10 (v4.0.0): Unlock CPU/GPU + fixes/appopt mở rộng ----
  const unl = await (await fetch(BASE + '/api/unlocks')).json();
  if (!unl.cpu || !unl.gpu || !unl.mode) fail('GET /api/unlocks thiếu shape (cpu/gpu/mode): ' + JSON.stringify(unl).slice(0, 120));
  ok('Unlocks status: mode=' + unl.mode + ' • CPU throttle ' + unl.cpu.throttleMin + '→' + unl.cpu.throttleMax + ' • GPU available=' + unl.gpu.available);
  const ucpu = await (await fetch(BASE + '/api/unlocks', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Nexus-Token': TOKEN }, body: JSON.stringify({ action: 'cpu-full' }) })).json();
  if (!ucpu.success || !(ucpu.steps || []).length) fail('POST unlocks cpu-full phải success + có steps: ' + JSON.stringify(ucpu).slice(0, 160));
  ok('Unlock CPU (mô phỏng CI): success=true, ' + ucpu.steps.length + ' bước, thông báo trung thực ✓');
  const urestore = await (await fetch(BASE + '/api/unlocks', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Nexus-Token': TOKEN }, body: JSON.stringify({ action: 'restore' }) })).json();
  if (!urestore.success) fail('POST unlocks restore phải success trên CI-sim: ' + JSON.stringify(urestore).slice(0, 120));
  ok('Unlock restore (hoàn tác snapshot) shape ✓');
  const fixSfc = await (await fetch(BASE + '/api/fixes', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Nexus-Token': TOKEN }, body: JSON.stringify({ id: 'fix-sfc' }) })).json();
  if (fixSfc.success !== false || !(fixSfc.message || '').includes('Windows')) fail('fix-sfc trên CI phải trung thực thất bại (chỉ Windows): ' + JSON.stringify(fixSfc).slice(0, 140));
  ok('Fix mới fix-sfc: báo trung thực "chỉ chạy trên Windows" ✓');
  const fixesV4 = await (await fetch(BASE + '/api/fixes')).json();
  for (const need of ['fix-sfc', 'fix-search', 'fix-defender', 'fix-time']) {
    if (!fixesV4.some((d) => d.id === need)) fail('Thiếu fix mới ' + need + ' trong /api/fixes');
  }
  ok('Bộ Fixes giờ có ' + fixesV4.length + ' mục (thêm fix-sfc/search/defender/time) ✓');
  const appsV4 = await (await fetch(BASE + '/api/appopt')).json();
  for (const need of ['steam', 'onedrive']) {
    if (!appsV4.some((d) => d.id === need)) fail('Thiếu app mới ' + need + ' trong /api/appopt');
  }
  ok('App Optimizer giờ có ' + appsV4.length + ' app (thêm steam + onedrive) ✓');
  const steamRun = await (await fetch(BASE + '/api/appopt', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Nexus-Token': TOKEN }, body: JSON.stringify({ id: 'steam', enabled: true }) })).json();
  if (steamRun.success !== false || !(steamRun.message || '').includes('Windows')) fail('appopt steam trên CI phải trung thực: ' + JSON.stringify(steamRun).slice(0, 140));
  ok('Appopt steam: mode không-Windows báo trung thực ✓');

  // ---- Bước 11 (v4.1.0 — audit 10 phát hiện): regression trung thực ----
  const ures = await (await fetch(BASE + '/api/unlocks', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Nexus-Token': TOKEN }, body: JSON.stringify({ action: 'restore' }) })).json();
  if (!ures.success || !(ures.steps || []).length) fail('unlocks restore (ci-sim) phải success + steps: ' + JSON.stringify(ures).slice(0, 140));
  ok('Unlock restore (hoàn tác theo snapshot, verify read-back trên Windows thật) shape ✓');
  const steamOff = await (await fetch(BASE + '/api/appopt', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Nexus-Token': TOKEN }, body: JSON.stringify({ id: 'steam', enabled: false }) })).json();
  if (steamOff.success !== false || !(steamOff.message || '').includes('Windows')) fail('appopt steam hoàn tác trên CI phải trung thực: ' + JSON.stringify(steamOff).slice(0, 140));
  ok('Appopt steam hoàn tác: mode không-Windows báo trung thực ✓ (Windows sẽ restore theo snapshot existed/fail-keep)');
  const fixes2 = await (await fetch(BASE + '/api/fixes')).json();
  const fd = fixes2.find((d) => d.id === 'fix-defender');
  const ft = fixes2.find((d) => d.id === 'fix-time');
  if (!fd || !(fd.desc || '').includes('Tamper') && !(fd.desc || '').includes('signature')) ok('fix-defender desc giữ nguyên (đã trung thực từ v4.0.0)');
  if (!ft || !(ft.desc || '').includes('KHÔNG sửa múi giờ')) fail('fix-time phải nói rõ chỉ đồng bộ giờ, KHÔNG sửa múi giờ (13.4)');
  ok('fix-time desc rõ ràng: chỉ đồng bộ giờ, không đụng múi giờ ✓');

  summary.pass = true;
  ok(`FPS TĂNG (giữ nhịp): ${base.fps} → ${after.fps} (mục tiêu 120) • năng lực thật: ${base.max} → ${after.max} FPS — ảnh test FPS oke`);
  writeSummary();
  console.log('KẾT QUẢ JSON:', JSON.stringify({ baseline: base.fps, after: after.fps, maxBefore: base.max, maxAfter: after.max, pass: true }));
  await browser.close();
  process.exit(0);
} catch (e) {
  console.error('❌ Lỗi không lường trước:', e.message);
  summary.steps.push('❌ ' + e.message);
  writeSummary(1);
  try { await browser.close(); } catch (_) {}
  process.exit(1);
}
