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

const summary = { baseline: null, after: null, pass: false, steps: [] };
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
    `| FPS baseline (mặc định 60) | ${summary.baseline ?? '—'} |`,
    `| FPS sau Tối ưu (mục tiêu 120) | ${summary.after ?? '—'} |`,
    `| Kết luận | ${summary.pass ? '✅ ĐẠT — FPS tăng từ 60 lên ' + summary.after : '❌ FAIL'} |`,
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
  await page.waitForFunction(() => document.querySelector('#benchVerdict').dataset.done === '1', { timeout: 30000 });
  const text = await page.$eval('#benchVerdict', (el) => el.textContent);
  const fps = Math.round(Number((text.match(/([\d.]+)\s*FPS/) || [])[1]));
  if (!Number.isFinite(fps)) fail('Không đọc được FPS từ verdict: ' + text);
  await sleep(300); // đợi render verdict ổn định
  await page.screenshot({ path: path.join(SHOTS, shot) });
  ok(`FPS test (${shot}): ${text}`);
  return { fps, text };
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

  await page.waitForSelector('#perfCard', { timeout: 15000 });
  ok('UI mở được, card Hiệu năng hiển thị');

  // ---- Bước 2: FPS baseline (mặc định 60) ----
  const base = await runBench(page, '00-baseline-60fps.png');
  summary.baseline = base.fps;
  if (base.fps < 50 || base.fps > 75) fail(`Baseline phải ≈60 (nhận ${base.fps}) — mặc định của tool là 60`);
  ok(`Baseline ≈60 xác nhận (thực tế ${base.fps} FPS)`);
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

  // ---- Bước 5: FPS test lần 2, kỳ vọng ≥105 (mục tiêu 120) ----
  const after = await runBench(page, '03-fps-after-120.png');
  summary.after = after.fps;
  if (after.fps < 105) fail(`FPS sau Tối ưu phải ≥105 (mục tiêu 120, nhận ${after.fps})`);
  if (after.fps <= base.fps) fail('FPS sau Tối ưu phải TĂNG so với baseline');

  summary.pass = true;
  ok(`FPS TĂNG: ${base.fps} → ${after.fps} (mục tiêu 120) — ảnh test FPS oke`);
  writeSummary();
  console.log('KẾT QUẢ JSON:', JSON.stringify({ baseline: base.fps, after: after.fps, pass: true }));
  await browser.close();
  process.exit(0);
} catch (e) {
  console.error('❌ Lỗi không lường trước:', e.message);
  summary.steps.push('❌ ' + e.message);
  writeSummary(1);
  try { await browser.close(); } catch (_) {}
  process.exit(1);
}
