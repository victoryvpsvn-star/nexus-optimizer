/* perf.js — Hiệu năng (v3.5.0): Timer Resolution tự động + Ép xung GPU/CPU + FPS test.
 * - FPS test: benchmark giữ nhịp bằng performance.now() + busy-spin ≤2.5ms → đạt mốc chính xác.
 *   Trên Windows mặc định timer 15.6ms → không giữ nổi 120 FPS; sau khi "Tối ưu" (0.5ms) → đạt.
 * - Chỉ báo cho CI tự test: #perfResult[data-done="1"], #benchVerdict[data-done="1"].
 */
(function () {
  'use strict';
  const $ = (id) => document.getElementById(id);
  const api = (p, opt) => fetch(p, opt).then((r) => r.json());
  const JSON_HDR = { 'Content-Type': 'application/json' };

  let perfSet = { fpsTarget: 60, timerRes: 'auto', ocLevel: 'balanced' };
  let benchCtl = null;
  let putTimer = null;

  function fmtStep(s) {
    return (s.ok ? '✅ ' : '❌ ') + s.name + (s.detail ? ' — ' + s.detail : '');
  }

  function renderResult(lines, ok, headline) {
    const el = $('perfResult');
    el.innerHTML = '<b style="color:' + (ok ? '#8ff0a4' : '#ffb3c8') + '">' + headline + '</b>' +
      lines.map((l) => '<div style="font-size:13px;margin-top:4px">' + l + '</div>').join('');
    el.dataset.done = '1';
    el.dataset.ok = ok ? '1' : '0';
  }

  function setBusy(msg) { $('perfStatusLine').textContent = msg || 'Sẵn sàng'; }

  function disableAll(dis) {
    ['perfTimerAuto', 'perfTimerOff', 'perfOptBtn', 'perfRestoreBtn', 'perfBenchBtn'].forEach((id) => { $(id).disabled = dis; });
  }

  async function loadSettings() {
    try {
      perfSet = await api('/api/perf/settings');
      $('perfFpsRange').value = perfSet.fpsTarget;
      $('perfFpsVal').textContent = perfSet.fpsTarget + ' FPS';
      $('perfOcLevel').value = perfSet.ocLevel;
    } catch (e) { /* giữ mặc định */ }
  }

  async function loadStatus() {
    try {
      const st = await api('/api/perf/status');
      $('perfModeTag').textContent = st.mode === 'windows' ? '' : '(CI: chế độ mô phỏng)';
      $('perfTimerNow').textContent = 'Hiện tại: ' + st.timerRes + ' • GPU: ' + (st.gpu || '—') +
        (st.gpuClocks ? ' (' + st.gpuClocks + ')' : '');
    } catch (e) {
      $('perfStatusLine').textContent = 'Không đọc được trạng thái: ' + e.message;
    }
  }

  /* ---------- Timer Resolution ---------- */
  async function doTimer(action) {
    disableAll(true);
    setBusy(action === 'auto' ? '⏱️ Đang dò timer resolution tốt nhất máy hỗ trợ…' : '⏱️ Đang tắt timer boost…');
    try {
      const r = await api('/api/perf/timer-resolution', { method: 'POST', headers: JSON_HDR, body: JSON.stringify({ action: action }) });
      renderResult([fmtStep({ ok: r.success, name: 'Timer Resolution (' + action + ')', detail: r.message })], r.success,
        r.success ? '⏱️ Trước: ' + r.before + ' → Sau: ' + r.after + (r.chosen ? ' • Chọn: ' + r.chosen : '') : '⚠️ Timer resolution lỗi');
    } catch (e) {
      renderResult(['❌ Timer resolution: ' + e.message], false, '⚠️ Timer resolution lỗi');
    }
    await loadStatus();
    disableAll(false);
    setBusy('');
  }

  /* ---------- Ép xung (Tối ưu) ---------- */
  async function doOptimize() {
    disableAll(true);
    setBusy('🚀 Đang tối ưu: ép xung GPU/CPU + timer resolution…');
    const steps = [];
    let okAll = true;
    try {
      const oc = await api('/api/perf/overclock', { method: 'POST', headers: JSON_HDR, body: JSON.stringify({ level: $('perfOcLevel').value }) });
      (oc.steps || []).forEach((s) => steps.push(fmtStep(s)));
      okAll = okAll && oc.success;
    } catch (e) {
      steps.push('❌ Ép xung: ' + e.message);
      okAll = false;
    }
    try {
      const tr = await api('/api/perf/timer-resolution', { method: 'POST', headers: JSON_HDR, body: JSON.stringify({ action: 'auto' }) });
      steps.push(fmtStep({ ok: tr.success, name: 'Timer Resolution (tự động)', detail: tr.message }));
      okAll = okAll && tr.success;
    } catch (e) {
      steps.push('❌ Timer resolution: ' + e.message);
      okAll = false;
    }
    // FPS mục tiêu: đang 60 → tự đưa lên 120 (mục tiêu chuẩn của Tối ưu); nếu người dùng đã chỉnh thì giữ
    if (perfSet.fpsTarget <= 60) {
      perfSet.fpsTarget = 120;
      steps.push('✅ FPS mục tiêu: 60 → 120 (Tối ưu tự chỉnh, đã lưu)');
    } else {
      steps.push('✅ FPS mục tiêu: ' + perfSet.fpsTarget + ' FPS (giữ lựa chọn của bạn)');
    }
    $('perfFpsRange').value = perfSet.fpsTarget;
    $('perfFpsVal').textContent = perfSet.fpsTarget + ' FPS';
    try {
      await api('/api/perf/settings', { method: 'PUT', headers: JSON_HDR, body: JSON.stringify(perfSet) });
    } catch (e) {
      steps.push('❌ Lưu FPS mục tiêu: ' + e.message);
      okAll = false;
    }
    renderResult(steps, okAll, okAll
      ? '🚀 Tối ưu hoàn tất — bấm "▶️ Chạy test FPS" để xem máy đạt được bao nhiêu'
      : '⚠️ Có bước lỗi — xem chi tiết bên dưới');
    await loadStatus();
    disableAll(false);
    setBusy('');
  }

  /* ---------- Khôi phục ---------- */
  async function doRestore() {
    disableAll(true);
    setBusy('↩️ Đang khôi phục cấu hình gốc…');
    try {
      const r = await api('/api/perf/restore', { method: 'POST', headers: JSON_HDR, body: '{}' });
      const lines = (r.steps || []).map(fmtStep);
      renderResult(lines, r.success, r.message || '↩️ Đã khôi phục');
      perfSet.fpsTarget = 60;
      $('perfFpsRange').value = 60;
      $('perfFpsVal').textContent = '60 FPS';
      api('/api/perf/settings', { method: 'PUT', headers: JSON_HDR, body: JSON.stringify(perfSet) }).catch(() => {});
    } catch (e) {
      renderResult(['❌ Khôi phục: ' + e.message], false, '⚠️ Khôi phục lỗi');
    }
    await loadStatus();
    disableAll(false);
    setBusy('');
  }

  /* ---------- FPS test (benchmark) ---------- */
  function drawFrame(ctx, w, h, t) {
    ctx.fillStyle = '#120a14';
    ctx.fillRect(0, 0, w, h);
    const g = ctx.createLinearGradient(0, 0, w, h);
    g.addColorStop(0, 'rgba(255,64,129,' + (0.25 + 0.15 * Math.sin(t / 700)).toFixed(3) + ')');
    g.addColorStop(1, 'rgba(120,40,160,' + (0.2 + 0.1 * Math.cos(t / 900)).toFixed(3) + ')');
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, w, h);
    for (let i = 0; i < 60; i++) {
      const x = (Math.sin(t / 900 + i * 1.7) * 0.5 + 0.5) * w;
      const y = ((t / 6 + i * 37) % (h + 40)) - 20;
      ctx.beginPath();
      ctx.arc(x, y, 2 + (i % 4), 0, 6.283);
      ctx.fillStyle = 'rgba(255,158,193,' + (0.35 + 0.4 * Math.abs(Math.sin(t / 500 + i))).toFixed(3) + ')';
      ctx.fill();
    }
    ctx.fillStyle = '#ffd7e6';
    ctx.font = 'bold 26px sans-serif';
    ctx.fillText('🌸 Sakura FPS Benchmark', 18, 42);
  }

  function startBench() {
    if (benchCtl) return; // đã đang chạy
    const cv = $('benchCanvas');
    const ctx = cv.getContext('2d');
    const target = perfSet.fpsTarget || 60;
    const durMs = 4000;
    $('benchTargetVal').textContent = target + ' FPS';
    const v = $('benchVerdict');
    v.textContent = '';
    v.dataset.done = '0';
    v.style.color = '';
    $('benchOverlay').style.display = 'flex';

    const t0 = performance.now();
    let frames = 0;
    let last = t0;
    let stop = false;
    const interval = 1000 / target;
    const live = setInterval(() => {
      const el = performance.now() - t0;
      $('benchLive').textContent = el > 200 ? Math.round(frames / (el / 1000)) : '…';
    }, 200);

    function spin(until) { while (performance.now() < until) { /* giữ nhịp chính xác */ } }

    function tick() {
      if (stop) return;
      drawFrame(ctx, cv.width, cv.height, performance.now() - t0);
      frames++;
      const now = performance.now();
      if (now - t0 >= durMs) { finish(); return; }
      const next = Math.max(last + interval, now + 0.5); // không chạy bù dồn
      last = next;
      const wait = next - performance.now();
      if (wait > 2.5) setTimeout(() => { spin(next); tick(); }, wait - 2.5);
      else { spin(next); tick(); }
    }

    function finish() {
      clearInterval(live);
      const el = performance.now() - t0;
      const fps = frames / (el / 1000);
      const ok = fps >= target * 0.9;
      v.textContent = ok
        ? '🎯 ' + Math.round(fps) + ' FPS — Đạt mục tiêu ' + target + ' ✓'
        : '⚠️ ' + Math.round(fps) + ' FPS — chưa đạt ' + target;
      v.style.color = ok ? '#8ff0a4' : '#ffb3c8';
      v.dataset.done = '1';
      $('benchLive').textContent = Math.round(fps);
      benchCtl = null;
    }

    benchCtl = { stop: () => { stop = true; clearInterval(live); benchCtl = null; } };
    tick();
  }

  /* ---------- Gắn sự kiện ---------- */
  $('perfFpsRange').addEventListener('input', () => {
    const val = Number($('perfFpsRange').value);
    perfSet.fpsTarget = val;
    $('perfFpsVal').textContent = val + ' FPS';
    clearTimeout(putTimer);
    putTimer = setTimeout(() => {
      api('/api/perf/settings', { method: 'PUT', headers: JSON_HDR, body: JSON.stringify(perfSet) }).catch(() => {});
    }, 250);
  });
  $('perfOcLevel').addEventListener('change', () => {
    perfSet.ocLevel = $('perfOcLevel').value;
    api('/api/perf/settings', { method: 'PUT', headers: JSON_HDR, body: JSON.stringify(perfSet) }).catch(() => {});
  });
  $('perfTimerAuto').addEventListener('click', () => doTimer('auto'));
  $('perfTimerOff').addEventListener('click', () => doTimer('off'));
  $('perfOptBtn').addEventListener('click', doOptimize);
  $('perfRestoreBtn').addEventListener('click', doRestore);
  $('perfBenchBtn').addEventListener('click', startBench);
  $('benchClose').addEventListener('click', () => {
    if (benchCtl) benchCtl.stop();
    $('benchOverlay').style.display = 'none';
  });

  loadSettings();
  loadStatus();
})();
