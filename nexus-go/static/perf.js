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
    $('benchTargetVal').textContent = target + ' FPS';
    const v = $('benchVerdict');
    v.textContent = '';
    v.dataset.done = '0';
    delete v.dataset.paced;
    delete v.dataset.max;
    v.style.color = '';
    $('benchPhase').textContent = 'Giai đoạn 1/2 — giữ nhịp mục tiêu ' + target + ' FPS (4 giây)…';
    $('benchOverlay').style.display = 'flex';

    let frames = 0;
    let stop = false;
    let t0 = performance.now();
    let last = t0;
    const interval = 1000 / target;
    const live = setInterval(() => {
      const el = performance.now() - t0;
      $('benchLive').textContent = el > 200 ? Math.round(frames / (el / 1000)) : '…';
    }, 200);

    function spin(until) { while (performance.now() < until) { /* giữ nhịp chính xác */ } }

    /* PHA 1 — giữ nhịp: vẽ đúng nhịp 1000/target ms (test ngưỡng, chứng minh timer giữ được nhịp) */
    function tickPaced() {
      if (stop) return;
      drawFrame(ctx, cv.width, cv.height, performance.now() - t0);
      frames++;
      const now = performance.now();
      if (now - t0 >= 4000) { startMax(); return; }
      const next = Math.max(last + interval, now + 0.5); // không chạy bù dồn
      last = next;
      const wait = next - performance.now();
      if (wait > 2.5) setTimeout(() => { spin(next); tickPaced(); }, wait - 2.5);
      else { spin(next); tickPaced(); }
    }

    /* PHA 2 — tối đa: bơm frame KHÔNG GIỚI HẠN qua MessageChannel (không qua timer,
     * không bị clamp 4ms của setTimeout) → đo throughput render THẬT của máy,
     * không đặt trước số nào. */
    function startMax() {
      const pacedFps = frames / ((performance.now() - t0) / 1000);
      v.dataset.paced = String(Math.round(pacedFps));
      frames = 0;
      t0 = performance.now();
      $('benchPhase').textContent = 'Giai đoạn 2/2 — đo NĂNG LỰC TỐI ĐA thật, không giới hạn (3 giây)…';
      const chan = new MessageChannel();
      chan.port1.onmessage = () => {
        if (stop) return;
        drawFrame(ctx, cv.width, cv.height, performance.now() - t0);
        frames++;
        if (performance.now() - t0 >= 3000) { finishMax(); return; }
        chan.port2.postMessage(0);
      };
      chan.port2.postMessage(0);
    }

    function finishMax() {
      clearInterval(live);
      const maxFps = frames / ((performance.now() - t0) / 1000);
      const paced = Number(v.dataset.paced || 0);
      v.dataset.max = String(Math.round(maxFps));
      v.dataset.done = '1';
      const pacedOk = paced >= target * 0.9;
      const maxOk = maxFps >= target;
      if (pacedOk && maxOk) {
        v.textContent = '🎯 Giữ nhịp ' + paced + ' FPS (mục tiêu ' + target + ') ✓ • Tối đa thật: ' + Math.round(maxFps) + ' FPS';
        v.style.color = '#8ff0a4';
      } else if (!maxOk) {
        v.textContent = '❌ Năng lực thật chỉ ' + Math.round(maxFps) + ' FPS — máy không đủ ' + target + ' (giới hạn phần cứng, tool không làm phép màu)';
        v.style.color = '#ffb3c8';
      } else {
        v.textContent = '⚠️ Máy render được ' + Math.round(maxFps) + ' FPS nhưng chỉ giữ nhịp ' + paced + '/' + target + ' — timer/CPU chưa đủ nhịp (bấm 🚀 Tối ưu để đặt timer 0.5ms)';
        v.style.color = '#ffd98f';
      }
      $('benchLive').textContent = Math.round(maxFps);
      $('benchPhase').textContent = 'Xong — nhịp mục tiêu: ' + paced + ' FPS • năng lực tối đa thật: ' + Math.round(maxFps) + ' FPS';
      benchCtl = null;
    }

    benchCtl = { stop: () => { stop = true; clearInterval(live); benchCtl = null; } };
    tickPaced();
  }

  /* ---------- GPU ưu tiên cao cho game (v3.6.0) ---------- */
  const escHtml = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  function renderGameGpuList(lst) {
    const el = $('perfGameGpuList');
    if (!el) return;
    const rows = ((lst && lst.entries) || []).map((e) => `<div>⚡ ${escHtml(e.path)} — <span class="muted">${escHtml(e.value)}</span></div>`).join('');
    el.innerHTML = rows ? `<div style="margin-top:6px"><b>Đã đặt ưu tiên cao (${(lst.entries || []).length}):</b>${rows}</div>`
      : '<div style="margin-top:6px">Chưa đặt GPU ưu tiên cao cho game nào</div>';
  }
  async function refreshGameGpu() {
    try { renderGameGpuList(await api('/api/perf/game-gpu')); } catch (_) {}
  }
  async function doGameGpu(action) {
    const pathEl = $('perfGameGpuPath');
    const path = (pathEl.value || '').trim();
    if (!path) { setBusy('⚠️ Nhập đường dẫn file .exe của game (ví dụ D:\\Games\\game.exe)'); return; }
    try {
      const r = await api('/api/perf/game-gpu', { method: 'POST', headers: JSON_HDR, body: JSON.stringify({ path, action }) });
      renderResult([escHtml(r.message || '')], r.success, action === 'set' ? '🎮 GPU ưu tiên cao cho game' : '↩️ Gỡ ưu tiên GPU');
      if (r.success && action === 'set') pathEl.value = '';
      await refreshGameGpu();
    } catch (e) { renderResult([escHtml(e.message || '')], false, '🎮 GPU ưu tiên cao cho game'); }
  }
  const ggSet = $('perfGameGpuSet'), ggClear = $('perfGameGpuClear');
  if (ggSet) ggSet.addEventListener('click', () => doGameGpu('set'));
  if (ggClear) ggClear.addEventListener('click', () => doGameGpu('clear'));
  refreshGameGpu();

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
