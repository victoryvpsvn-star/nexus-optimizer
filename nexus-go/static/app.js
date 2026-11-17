/* Sakura Tool — Go edition, app.js (vanilla, gọi cùng JSON API như bản cũ) */
'use strict';

const $ = (id) => document.getElementById(id);
const SECTION_META = {
  overview: ['Tổng quan', 'Giám sát CPU, RAM, Disk realtime'],
  cleanup: ['Dọn dẹp', 'Giải phóng RAM + Disk chỉ với một cú nhấp'],
  gaming: ['Gaming Mode', 'Tăng hiệu năng tối đa khi chơi game'],
  tweaks: ['Tinh chỉnh', 'Danh sách tối ưu xếp hạng theo độ ưu tiên'],
  appopt: ['App Optimizer', 'Tối ưu riêng từng app phổ biến — phát hiện app đã cài thật trên máy'],
  fixes: ['Fixes', 'Sửa nhanh các lỗi Windows thường gặp — 1 nút bấm'],
  processes: ['Tiến trình', 'Quản lý tiến trình đang chạy'],
  network: ['Mạng', 'Giao diện + cổng đang lắng nghe'],
  script: ['Script nâng cao', 'Tự viết và chạy script tùy chỉnh — Advanced'],
  selftest: ['Tự kiểm tra', 'Kiểm tra sức khỏe hệ thống + toàn bộ tinh chỉnh, báo cáo về Discord'],
  screenshot: ['Ảnh chụp', 'Chụp & lưu ảnh màn hình dashboard'],
  backup: ['Sao lưu', 'Backup registry các key tinh chỉnh (file .reg)'],
  settings: ['Cài đặt', 'Tùy chỉnh màu nhấn, bo góc, hiệu ứng'],
};

let tweaksCache = [];
let tweakFilter = 'all';
let selectedTweaks = new Set();
let tweakSearch = '';
let tweakLimit = 150;
const TWEAK_PAGE = 150;
let tweaksRunning = false; // v3.4.0: guard double-click
let statsTimer = null;

// ---------- helpers ----------
async function api(path, opts = {}) {
  const res = await fetch(path, {
    headers: { 'Content-Type': 'application/json' },
    ...opts,
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  });
  let data = {};
  try { data = await res.json(); } catch { /* body rỗng */ }
  if (!res.ok) {
    throw new Error(data.error || `HTTP ${res.status}`);
  }
  return data;
}

function toast(msg, kind = '') {
  const el = document.createElement('div');
  el.className = 'toast ' + kind;
  el.textContent = msg;
  $('toast-wrap').appendChild(el);
  setTimeout(() => el.remove(), 6000);
}

function fmtBytes(b) {
  if (b >= 1e9) return (b / 1e9).toFixed(2) + ' GB';
  if (b >= 1e6) return (b / 1e6).toFixed(1) + ' MB';
  if (b >= 1e3) return (b / 1e3).toFixed(1) + ' KB';
  return b + ' B';
}

function esc(s) {
  const d = document.createElement('div');
  d.textContent = String(s ?? '');
  return d.innerHTML.replace(/"/g, '&quot;').replace(/'/g, '&#39;'); // v3.4.0 fix: escape nháy cho attribute
}

function setBusy(elId, text) { $(elId).textContent = text || ''; }

// ---------- navigation ----------
document.querySelectorAll('.nav-item').forEach((btn) => {
  btn.addEventListener('click', () => showSection(btn.dataset.section));
});

function showSection(name) {
  document.querySelectorAll('.nav-item').forEach((b) => b.classList.toggle('active', b.dataset.section === name));
  document.querySelectorAll('.section').forEach((s) => s.classList.toggle('active', s.id === 'sec-' + name));
  const meta = SECTION_META[name] || ['', ''];
  $('sectionTitle').textContent = meta[0];
  $('sectionSub').textContent = meta[1];
  clearInterval(statsTimer);
  statsTimer = null;
  if (name === 'overview') {
    refreshStats();
    refreshFreedStats();
    statsTimer = setInterval(refreshStats, 3000);
  } else if (name === 'cleanup') refreshCleanup();
  else if (name === 'gaming') refreshGaming();
  else if (name === 'tweaks') refreshTweaks();
  else if (name === 'appopt') refreshAppOpt();
  else if (name === 'fixes') refreshFixes();
  else if (name === 'processes') refreshProcesses();
  else if (name === 'network') refreshNetwork();
  else if (name === 'script') refreshScripts();
  else if (name === 'selftest') refreshSelftestInfo();
  else if (name === 'screenshot') refreshShots();
  else if (name === 'backup') refreshBackups();
  else if (name === 'settings') refreshSettings();
}

// ---------- Overview ----------
async function refreshStats() {
  try {
    const s = await api('/api/stats');
    $('ovCpu').textContent = s.cpu.usage.toFixed(1) + '%';
    $('ovCpuDesc').textContent = `${s.cpu.cores} lõi — ${s.cpu.model || 'CPU'}`;
    $('ovCpuBar').style.width = Math.min(100, s.cpu.usage) + '%';
    $('ovMem').textContent = s.mem.usagePct.toFixed(1) + '%';
    $('ovMemDesc').textContent = `${s.mem.usedMB} / ${s.mem.totalMB} MB (còn ${s.mem.availableMB} MB)`;
    $('ovMemBar').style.width = Math.min(100, s.mem.usagePct) + '%';
    const d0 = s.disks && s.disks[0];
    if (d0) {
      $('ovDisk').textContent = d0.usagePct.toFixed(1) + '%';
      $('ovDiskDesc').textContent = `${d0.mount}: còn ${d0.freeGB.toFixed(1)} GB / ${d0.totalGB.toFixed(1)} GB`;
      $('ovDiskBar').style.width = Math.min(100, d0.usagePct) + '%';
    }
    $('ovNet').textContent = `${Math.round(s.net.rxKBs)} / ${Math.round(s.net.txKBs)}`;
    $('ovNetDesc').textContent = `↓ rx / ↑ tx KB/s — tổng ${s.net.rxTotalMB} MB ↓ / ${s.net.txTotalMB} MB ↑`;
    const tbody = $('ovDisks').querySelector('tbody');
    tbody.innerHTML = (s.disks || []).map((d) =>
      `<tr><td>${esc(d.mount)}</td><td class="num">${d.totalGB.toFixed(1)} GB</td><td class="num">${d.usedGB.toFixed(1)} GB</td><td class="num">${d.freeGB.toFixed(1)} GB</td><td class="num">${d.usagePct.toFixed(1)}%</td></tr>`
    ).join('') || '<tr><td colspan="5" class="muted">Không đọc được ổ đĩa</td></tr>';
    $('ovSys').innerHTML = `
      <div><b>Hostname</b> ${esc(s.hostname)}</div>
      <div><b>Nền tảng</b> ${esc(s.platform)}</div>
      <div><b>Uptime</b> ${Math.floor(s.uptimeSec / 3600)}h ${Math.floor((s.uptimeSec % 3600) / 60)}m</div>
      <div><b>Số tiến trình</b> ${s.processCount}</div>`;
    pushCpu(s.cpu.usage);
  } catch (e) {
    console.error('stats', e);
  }
}

// ---------- CPU sparkline + thống kê đã giải phóng ----------
const cpuHist = [];
function pushCpu(v) {
  cpuHist.push(v);
  if (cpuHist.length > 60) cpuHist.shift();
  drawCpuChart();
}
function drawCpuChart() {
  const cv = $('cpuChart');
  if (!cv) return;
  const ctx = cv.getContext('2d');
  const W = cv.width, H = cv.height;
  ctx.clearRect(0, 0, W, H);
  ctx.strokeStyle = 'rgba(255,126,182,.14)';
  ctx.lineWidth = 1;
  [25, 50, 75].forEach((g) => {
    const y = H - 10 - (g / 100) * (H - 20);
    ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(W, y); ctx.stroke();
  });
  if (cpuHist.length < 2) return;
  const pt = (i) => [(i / (cpuHist.length - 1)) * (W - 4) + 2, H - 10 - (Math.min(100, cpuHist[i]) / 100) * (H - 20)];
  const grad = ctx.createLinearGradient(0, 0, 0, H);
  grad.addColorStop(0, 'rgba(255,126,182,.45)');
  grad.addColorStop(1, 'rgba(255,126,182,0)');
  ctx.beginPath();
  ctx.moveTo(...pt(0));
  for (let i = 1; i < cpuHist.length; i++) ctx.lineTo(...pt(i));
  const [lx, ly] = pt(cpuHist.length - 1);
  ctx.lineTo(lx, H); ctx.lineTo(2, H); ctx.closePath();
  ctx.fillStyle = grad; ctx.fill();
  ctx.beginPath();
  ctx.moveTo(...pt(0));
  for (let i = 1; i < cpuHist.length; i++) ctx.lineTo(...pt(i));
  ctx.strokeStyle = '#ff7eb6'; ctx.lineWidth = 2.5; ctx.stroke();
  ctx.beginPath(); ctx.arc(lx, ly, 4, 0, Math.PI * 2); ctx.fillStyle = '#ffb7d5'; ctx.fill();
}
async function refreshFreedStats() {
  try {
    const d = await api('/api/cleanup');
    const el = $('ovFreed');
    if (!el) return;
    el.textContent = fmtBytes(d.totalFreedAllTime || 0);
    $('ovFreedDesc').textContent = d.lastRan
      ? ('Dọn gần nhất: ' + new Date(d.lastRan).toLocaleString('vi-VN'))
      : 'Chưa dọn lần nào — vào tab Dọn dẹp 🌸';
  } catch (_) {}
}

let cleanupSel = new Set();
let cleanupTargetsCache = [];

async function refreshCleanup() {
  try {
    const d = await api('/api/cleanup');
    cleanupTargetsCache = d.targets || [];
    $('cleanupRamNote').textContent = d.ramNote || '';
    renderCleanupList();
    const logs = $('cleanupLogs').querySelector('tbody');
    logs.innerHTML = (d.logs || []).slice(0, 15).map((l) =>
      `<tr><td class="muted">${new Date(l.createdAt).toLocaleString('vi-VN')}</td><td>${esc(l.kind)}</td><td>${esc(l.target)}</td><td class="num">${l.freedBytes > 0 ? fmtBytes(l.freedBytes) : '—'}</td><td class="${l.success ? 'st-ok' : 'st-fail'}">${l.success ? '✅' : '❌'} ${esc(l.message || '')}</td></tr>`
    ).join('') || '<tr><td colspan="5" class="muted">Chưa có log nào</td></tr>';
  } catch (e) {
    toast('Không quét được mục tiêu dọn dẹp: ' + e.message, 'err');
  }
}

function renderCleanupList() {
  const wrap = $('cleanupList');
  if (!wrap) return;
  wrap.innerHTML = cleanupTargetsCache.map((t) => {
    const dis = !t.canClean;
    const size = t.sizeBytes > 0 ? fmtBytes(t.sizeBytes) : (dis ? '⚠️ cần Admin' : '—');
    return `<label class="clean-row${cleanupSel.has(t.id) ? ' selected' : ''}${dis ? ' disabled' : ''}">
      <input type="checkbox" class="clean-check" data-id="${t.id}" ${cleanupSel.has(t.id) ? 'checked' : ''} ${dis ? 'disabled' : ''}>
      <div class="clean-info">
        <div class="clean-name">${esc(t.name)}${t.admin ? ' <span class="tag">🔑 cần Admin</span>' : ''}</div>
        <div class="clean-path muted">${esc(t.path || '')}${t.note ? ' — ' + esc(t.note) : ''}</div>
      </div>
      <div class="clean-size num">${size}</div>
    </label>`;
  }).join('') || '<div class="muted">Không có mục tiêu nào</div>';
  wrap.querySelectorAll('.clean-check').forEach((c) => c.addEventListener('change', () => {
    if (c.checked) cleanupSel.add(c.dataset.id); else cleanupSel.delete(c.dataset.id);
    c.closest('.clean-row').classList.toggle('selected', c.checked);
    updateSelInfo();
  }));
  updateSelInfo();
}

function updateSelInfo() {
  let n = 0, sz = 0;
  cleanupTargetsCache.forEach((t) => { if (cleanupSel.has(t.id)) { n++; sz += t.sizeBytes || 0; } });
  $('cleanupSelInfo').textContent = `Đã chọn ${n} mục — dung lượng có thể giải phóng ~${fmtBytes(sz)}`;
}

async function runCleanup(action, busyId, targets) {
  setBusy(busyId, 'Đang chạy…');
  try {
    const r = await api('/api/cleanup', { method: 'POST', body: { action, targets } });
    const lines = (r.results || []).map((x) => `${x.success ? '✅' : '❌'} ${x.name}: ${x.message}`);
    $('cleanupResultsCard').style.display = '';
    $('cleanupResults').innerHTML = lines.map((l) => `<div class="muted">${esc(l)}</div>`).join('');
    toast(`Dọn xong — disk giải phóng ${fmtBytes(r.totalFreedDisk || 0)}, RAM ${fmtBytes(r.totalFreedRam || 0)}`, r.totalFreedDisk + r.totalFreedRam > 0 ? 'ok' : '');
    refreshCleanup();
    refreshFreedStats();
    refreshStats();
  } catch (e) {
    toast('Dọn dẹp lỗi: ' + e.message, 'err');
  } finally {
    setBusy(busyId, '');
  }
}
$('cleanupSelectAll').addEventListener('click', () => {
  cleanupTargetsCache.forEach((t) => { if (t.canClean) cleanupSel.add(t.id); });
  renderCleanupList();
});
$('cleanupSelectNone').addEventListener('click', () => { cleanupSel.clear(); renderCleanupList(); });
$('cleanupSelected').addEventListener('click', () => {
  if (cleanupSel.size === 0) { toast('Hãy tick chọn ít nhất một mục muốn dọn 🌸', 'err'); return; }
  runCleanup('disk', 'cleanupBusy', Array.from(cleanupSel));
});
$('cleanupRam').addEventListener('click', () => runCleanup('ram', 'cleanupBusy'));

// ---------- Gaming ----------
async function refreshGaming() {
  try {
    const g = await api('/api/gaming');
    $('gamingNote').textContent = g.note || '';
    $('gamingToggle').textContent = g.enabled ? '↩️ Tắt Gaming Mode' : '🎮 Bật Gaming Mode';
    $('gamingToggle').dataset.enabled = g.enabled ? '1' : '';
    $('gamingStatus').textContent = g.enabled
      ? `Đang bật — từ ${g.enabledAt ? new Date(g.enabledAt).toLocaleString('vi-VN') : '—'}`
      : 'Đang tắt';
    const tbody = $('gamingEffects').querySelector('tbody');
    tbody.innerHTML = (g.effects || []).map((e) =>
      `<tr><td>${esc(e.name)}</td><td class="${e.success ? 'st-ok' : 'st-fail'}">${e.success ? '✅' : '❌'}</td><td class="muted">${esc(e.message)}</td></tr>`
    ).join('') || '<tr><td colspan="3" class="muted">Chưa chạy lần nào</td></tr>';
  } catch (e) {
    toast('Không đọc được Gaming Mode: ' + e.message, 'err');
  }
}
$('gamingToggle').addEventListener('click', async () => {
  const enable = !$('gamingToggle').dataset.enabled;
  $('gamingToggle').disabled = true;
  try {
    await api('/api/gaming', { method: 'POST', body: { enabled: enable } });
    toast(enable ? 'Đã bật Gaming Mode' : 'Đã tắt Gaming Mode', 'ok');
  } catch (e) {
    toast('Gaming Mode lỗi: ' + e.message, 'err');
  } finally {
    $('gamingToggle').disabled = false;
    refreshGaming();
  }
});

// ---------- Tweaks ----------
async function refreshTweaks() {
  try {
    const d = await api('/api/tweaks');
    tweaksCache = d.tweaks || [];
    renderTweakFilters();
    renderTweaks();
  } catch (e) {
    toast('Không tải được danh sách tinh chỉnh: ' + e.message, 'err');
  }
}

function filteredTweaks() {
  const q = tweakSearch.trim().toLowerCase();
  return tweaksCache.filter((t) => (tweakFilter === 'all' || t.category === tweakFilter)
    && (!q || t.name.toLowerCase().includes(q) || t.description.toLowerCase().includes(q) || t.id.toLowerCase().includes(q)));
}

function renderTweaks() {
  const list = $('tweakList');
  const all = filteredTweaks();
  const items = all.slice(0, tweakLimit);
  const cnt = $('tweakCount');
  if (cnt) {
    const sel = [...selectedTweaks].length;
    cnt.textContent = `Hiển thị ${items.length}/${all.length}${tweakSearch ? ' (lọc "' + tweakSearch + '")' : ''}${sel ? ' · ' + sel + ' đã chọn' : ''}`;
  }
  const more = all.length > items.length
    ? `<div style="text-align:center;margin:14px 0"><button class="btn" id="tweakMore">⬇️ Hiện thêm ${Math.min(TWEAK_PAGE, all.length - items.length)} mục (còn ${all.length - items.length})</button></div>`
    : '';
  list.innerHTML = items.map((t) => `
    <div class="tweak" data-id="${esc(t.id)}">
      <div class="tweak-head">
        <input type="checkbox" class="tweak-check" data-id="${esc(t.id)}" ${selectedTweaks.has(t.id) ? 'checked' : ''}>
        <div class="tweak-body">
          <div class="tweak-name">${t.order}. ${esc(t.name)}</div>
          <div class="tweak-desc">${esc(t.description)}</div>
          <div class="tweak-meta">
            <span class="tag">${esc(t.category)}</span>
            <span class="tag risk-${t.risk}">rủi ro ${t.risk}</span>
            ${t.requiresRoot ? '<span class="tag">cần Admin</span>' : ''}
            ${t.recommended ? '<span class="tag recommended">khuyến nghị</span>' : ''}
            ${t.applied ? '<span class="tag applied">đã áp dụng</span>' : ''}
            <button class="btn" data-apply="${esc(t.id)}">Áp dụng</button>
            <button class="btn" data-revert="${esc(t.id)}">Hoàn tác</button>
          </div>
          ${t.lastResult ? `<div class="tweak-result">${esc(t.lastResult)}</div>` : ''}
        </div>
      </div>
    </div>`).join('') || '<p class="muted">Không có tinh chỉnh nào trong nhóm này.</p>';

  list.querySelectorAll('.tweak-check').forEach((cb) => {
    cb.addEventListener('change', () => {
      if (cb.checked) selectedTweaks.add(cb.dataset.id);
      else selectedTweaks.delete(cb.dataset.id);
    });
  });
  list.querySelectorAll('[data-apply]').forEach((b) => b.addEventListener('click', () => runTweaks([b.dataset.apply], 'apply')));
  list.querySelectorAll('[data-revert]').forEach((b) => b.addEventListener('click', () => runTweaks([b.dataset.revert], 'revert')));
  const mb = document.getElementById('tweakMore');
  if (mb) mb.addEventListener('click', () => { tweakLimit += TWEAK_PAGE; renderTweaks(); });
}

/** Filter chips sinh động theo nhóm thật trong catalog + đếm số lượng từng nhóm */
function renderTweakFilters() {
  const counts = {};
  tweaksCache.forEach((t) => { counts[t.category] = (counts[t.category] || 0) + 1; });
  const cats = ['all', ...Object.keys(counts)];
  const labels = { all: `Tất cả (${tweaksCache.length})` };
  const wrap = $('tweakFilters');
  wrap.innerHTML = cats.map((c) =>
    `<button class="chip ${tweakFilter === c ? 'active' : ''}" data-cat="${esc(c)}">${esc(labels[c] || `${c} (${counts[c] || 0})`)}</button>`
  ).join('');
  wrap.querySelectorAll('.chip').forEach((chip) => {
    chip.addEventListener('click', () => {
      wrap.querySelectorAll('.chip').forEach((c) => c.classList.remove('active'));
      chip.classList.add('active');
      tweakFilter = chip.dataset.cat;
      tweakLimit = TWEAK_PAGE;
      renderTweaks();
    });
  });
}

async function runTweaks(ids, action) {
  if (!ids.length) return toast('Chưa chọn mục nào', 'err');
  if (tweaksRunning) return toast('Đang chạy loạt tinh chỉnh — đợi xong đã', 'err');
  tweaksRunning = true;
  const verb = action === 'apply' ? 'áp dụng' : 'hoàn tác';
  let done = 0, fails = 0;
  try {
    // chia lô 100 mục/request — server nhận tối đa 200
    for (let i = 0; i < ids.length; i += 100) {
      const batch = ids.slice(i, i + 100);
      setBusy('tweaksBusy', `Đang ${verb} ${done + 1}–${done + batch.length}/${ids.length}…`);
      const r = await api('/api/tweaks', { method: 'POST', body: { ids: batch, action } });
      fails += (r.results || []).filter((x) => !x.success).length;
      done += batch.length;
    }
    toast(`${verb.charAt(0).toUpperCase() + verb.slice(1)} xong ${done} mục${fails ? ` — ${fails} lỗi (xem trong danh sách)` : ''}`, fails ? 'err' : 'ok');
    selectedTweaks.clear();
    refreshTweaks();
  } catch (e) {
    toast(`Chạy lỗi sau ${done}/${ids.length} mục (${fails} lỗi trước đó): ` + e.message, 'err');
    refreshTweaks();
  } finally {
    tweaksRunning = false;
    setBusy('tweaksBusy', '');
  }
}
$('tweaksApplySel').addEventListener('click', () => runTweaks([...selectedTweaks], 'apply'));
$('tweaksRevertSel').addEventListener('click', () => runTweaks([...selectedTweaks], 'revert'));
$('tweaksSelAll').addEventListener('click', () => {
  filteredTweaks().slice(0, tweakLimit).forEach((t) => selectedTweaks.add(t.id)); // v3.4.0 fix: chỉ chọn mục ĐANG hiển thị
  renderTweaks();
});
$('tweaksSelNone').addEventListener('click', () => {
  selectedTweaks.clear();
  renderTweaks();
});

// ---------- App Optimizer (v3.7.0) ----------
async function refreshAppOpt() {
  const el = $('appoptGrid');
  try {
    const cards = await api('/api/appopt');
    el.innerHTML = cards.map((c) => `
      <div class="acard ${c.applied ? 'on' : ''}">
        <div class="acard-head"><span class="acard-ico">${c.icon}</span><b>${esc(c.name)}</b></div>
        <p class="muted small">${esc(c.desc)}</p>
        ${c.warning ? `<div class="acard-warn">⚠️ ${esc(c.warning)}</div>` : ''}
        <div class="acard-foot">
          <span class="chip ${c.applied ? 'ok' : 'mut'}">${c.applied ? '✅ Đã tối ưu' : c.installed ? '⚪ Chưa tối ưu' : '—'}</span>
          <button class="btn ${c.applied ? '' : 'primary'}" data-appopt="${c.id}" data-enabled="${c.applied ? '0' : '1'}" data-name="${esc(c.name)}" ${!c.installed && c.needsAdmin ? 'disabled' : ''}>${c.applied ? '↩ Hoàn tác' : '⚡ Tối ưu'}</button>
        </div>
      </div>`).join('');
    el.querySelectorAll('[data-appopt]').forEach((b) => {
      b.addEventListener('click', async () => {
        const id = b.dataset.appopt, on = b.dataset.enabled === '1';
        if (!on && !confirm(`Hoàn tác tối ưu "${b.dataset.name}" về mặc định?`)) return;
        if (on && !confirm(`Tối ưu "${b.dataset.name}" ngay? Tác dụng và hoàn tác đều được ghi rõ trong kết quả.`)) return;
        b.disabled = true; b.textContent = 'Đang chạy…';
        try {
          const r = await api('/api/appopt', { method: 'POST', body: JSON.stringify({ id, enabled: on }) });
          toast(r.message || 'Xong', r.success ? 'ok' : 'err');
        } catch (e) { toast(e.message, 'err'); }
        refreshAppOpt();
      });
    });
  } catch (e) {
    el.innerHTML = `<div class="acard"><b>Lỗi</b><p class="muted">${esc(e.message)}</p></div>`;
  }
}

// ---------- Fixes (v3.7.0) ----------
async function refreshFixes() {
  const el = $('fixesGrid');
  try {
    const defs = await api('/api/fixes');
    el.innerHTML = defs.map((f) => `
      <div class="acard">
        <div class="acard-head"><span class="acard-ico">${f.icon}</span><b>${esc(f.name)}</b></div>
        <p class="muted small">${esc(f.desc)}</p>
        <div class="acard-foot">
          <span class="chip mut">${f.needsAdmin ? '🛡️ cần Admin' : '👤 không cần'}</span>
          <button class="btn primary" data-fix="${f.id}" data-name="${esc(f.name)}">🔧 Sửa ngay</button>
        </div>
        <div class="fix-result" id="fixres-${f.id}"></div>
      </div>`).join('');
    el.querySelectorAll('[data-fix]').forEach((b) => {
      b.addEventListener('click', async () => {
        if (!confirm(`Chạy fix "${b.dataset.name}" ngay bây giờ?`)) return;
        const id = b.dataset.fix;
        const res = $('fixres-' + id);
        b.disabled = true; b.textContent = 'Đang sửa…';
        try {
          const r = await api('/api/fixes', { method: 'POST', body: JSON.stringify({ id }) });
          res.innerHTML = (r.steps || []).map((s) => `<div>${s.ok ? '✅' : '❌'} ${esc(s.name)} — <span class="muted">${esc(s.detail || '')}</span></div>`).join('') +
            `<div style="margin-top:6px"><b>${esc(r.message || '')}</b></div>`;
          toast(r.message || 'Xong', r.success ? 'ok' : 'err');
        } catch (e) { res.textContent = '❌ ' + e.message; }
        b.disabled = false; b.textContent = '🔧 Sửa ngay';
      });
    });
  } catch (e) {
    el.innerHTML = `<div class="acard"><b>Lỗi</b><p class="muted">${esc(e.message)}</p></div>`;
  }
}

// ---------- Network test — Speed & Bufferbloat (v3.7.0, client-side qua Cloudflare) ----------
let netTestBusy = false;
const netMedian = (arr) => [...arr].sort((a, b) => a - b)[Math.floor(arr.length / 2)];
async function netFetchRTT() {
  const t0 = performance.now();
  await fetch('https://speed.cloudflare.com/__down?bytes=0&r=' + Math.random(), { cache: 'no-store' });
  return performance.now() - t0;
}
async function netDownloadMbps() {
  const t0 = performance.now();
  const resp = await fetch('https://speed.cloudflare.com/__down?bytes=12000000&r=' + Math.random(), { cache: 'no-store' });
  const reader = resp.body.getReader();
  let bytes = 0;
  for (;;) { const { done, value } = await reader.read(); if (done) break; bytes += value.length; }
  return (bytes * 8) / ((performance.now() - t0) / 1000) / 1e6;
}
function netGrade(ms) { return ms < 5 ? 'A+' : ms < 20 ? 'A' : ms < 40 ? 'B' : ms < 80 ? 'C' : ms < 150 ? 'D' : 'F'; }

async function runNetTest() {
  if (netTestBusy) return;
  const btn = $('netTestRun'), out = $('netTestResult'), table = $('netTestTable');
  netTestBusy = true; btn.disabled = true; btn.textContent = 'Đang test…';
  try {
    out.textContent = '⏱️ Đang đo độ trễ khi mạng rảnh…';
    const idle = [];
    for (let i = 0; i < 8; i++) { try { idle.push(await netFetchRTT()); } catch (_) {} }
    if (!idle.length) throw new Error('Không kết nối được Cloudflare — máy chưa có mạng?');
    const idleMs = netMedian(idle);
    out.textContent = '📥 Đang đo tốc độ tải + độ trễ khi mạng đang bận… (~12 MB, khoảng 10 giây)';
    const speedP = netDownloadMbps();
    await new Promise((r) => setTimeout(r, 800));
    const load = [];
    for (let i = 0; i < 8; i++) { try { load.push(await netFetchRTT()); } catch (_) {} }
    const mbps = await speedP;
    const loadMs = load.length ? netMedian(load) : idleMs;
    const bloat = Math.max(0, loadMs - idleMs);
    const g = netGrade(bloat);
    out.innerHTML = `<div class="net-res">
      <div class="net-stat"><b>${mbps.toFixed(1)}</b><span>Mbps tải</span></div>
      <div class="net-stat"><b>${Math.round(idleMs)}</b><span>ms ping rảnh</span></div>
      <div class="net-stat"><b>+${Math.round(bloat)}</b><span>ms ping khi bận</span></div>
      <div class="net-grade"><b>${g}</b><span>Bufferbloat</span></div>
    </div>`;
    const rows = [
      ['Duyệt web nhẹ', mbps >= 5],
      ['Gọi audio / video call', bloat < 150 && idleMs < 250],
      ['Xem phim 4K', mbps >= 25],
      ['Gaming online', bloat < 80 && idleMs < 120],
    ];
    table.innerHTML = `<table class="nettable"><thead><tr><th>Việc cần mạng</th><th>Kết luận trên mạng hiện tại</th></tr></thead><tbody>
      ${rows.map(([n, ok]) => `<tr><td>${n}</td><td>${ok ? '✅ Oke' : '⚠️ Khó chịu — tốc độ thấp hoặc bufferbloat cao'}</td></tr>`).join('')}
    </tbody></table>
    <p class="muted small">Bufferbloat = mức ping tăng khi mạng đang tải đầy: càng thấp càng tốt. Cao → bật QoS trên router hoặc hạn chế tải khi chơi game.</p>`;
  } catch (e) {
    out.textContent = '⚠️ ' + e.message;
    table.innerHTML = '';
  }
  netTestBusy = false; btn.disabled = false; btn.textContent = '▶️ Chạy test mạng';
}
$('netTestRun').addEventListener('click', runNetTest);

// ---------- Processes ----------
// v3.6.0: retry 1 lần khi fetch lỗi (tool vừa relaunch / network hiccup) — báo lỗi inline, không chỉ toast
async function fetchProcessesWithRetry() {
  try {
    return await api('/api/processes');
  } catch (_) {
    await new Promise((r) => setTimeout(r, 1200));
    return await api('/api/processes');
  }
}

async function refreshProcesses() {
  try {
    const d = await fetchProcessesWithRetry();
    const q = ($('procSearch').value || '').toLowerCase();
    const rows = (d.list || []).filter((p) => !q || p.name.toLowerCase().includes(q) || String(p.pid).includes(q));
    $('procTable').querySelector('tbody').innerHTML = rows.map((p) => `
      <tr>
        <td class="num">${p.pid}</td><td>${esc(p.name)}</td><td class="muted">${esc(p.user)}</td>
        <td class="num">${p.cpuPct.toFixed(1)}</td><td class="num">${p.memPct.toFixed(1)}</td><td class="num">${p.rssMB.toFixed(0)}</td>
        <td><button class="btn danger" data-kill="${p.pid}" data-name="${esc(p.name)}">Kill</button></td>
      </tr>`).join('') || '<tr><td colspan="7" class="muted">Không có tiến trình khớp</td></tr>';
    $('procTable').querySelectorAll('[data-kill]').forEach((b) => {
      b.addEventListener('click', async () => {
        if (!confirm(`Kết thúc tiến trình ${b.dataset.name} (PID ${b.dataset.kill})?`)) return;
        try {
          const r = await api(`/api/processes?pid=${b.dataset.kill}`, { method: 'DELETE' });
          toast(r.message || 'Xong', r.success ? 'ok' : 'err');
          refreshProcesses();
        } catch (e) { toast(e.message, 'err'); }
      });
    });
  } catch (e) {
    $('procTable').querySelector('tbody').innerHTML =
      `<tr><td colspan="7" class="muted">⚠️ ${esc(e.message)} — thử lại bằng nút ⟳ Làm mới</td></tr>`;
    toast('Không đọc được tiến trình: ' + e.message, 'err');
  }
}
$('procRefresh').addEventListener('click', refreshProcesses);
(() => { // v3.4.0: procSearch debounce 250ms như tweakSearch
  let tmr = null;
  $('procSearch').addEventListener('input', () => { clearTimeout(tmr); tmr = setTimeout(refreshProcesses, 250); });
})();

// ---------- Network ----------
async function refreshNetwork() {
  try {
    const d = await api('/api/network');
    $('netIfaces').innerHTML = (d.ifaces || []).map((i) =>
      `<div><b>${esc(i.name)}</b> ${i.ipv4.map(esc).join(', ')} ${i.mac ? `<span class="muted">${esc(i.mac)}</span>` : ''}</div>`
    ).join('') || '<div class="muted">Không có giao diện nào</div>';
    $('netPorts').innerHTML = (d.ports || []).map((p) =>
      `<span class="chip" style="cursor:default">${esc(p.port)}<span class="muted">/${esc(p.proto)}</span></span>`
    ).join('') || '<span class="muted">Không đọc được cổng LISTEN</span>';
  } catch (e) {
    toast('Không đọc được thông tin mạng: ' + e.message, 'err');
  }
}
$('netRefresh').addEventListener('click', refreshNetwork);

// ---------- Script ----------
async function refreshScripts() {
  try {
    const d = await api('/api/script');
    $('scriptLang').innerHTML = (d.languages || []).map((l) => `<option value="${esc(l)}">${esc(l)}</option>`).join('');
    $('scriptSaved').innerHTML = (d.scripts || []).map((s) =>
      `<span class="chip" data-load="${s.id}">📜 ${esc(s.name)} <button style="all:unset;color:var(--err);cursor:pointer" data-del="${s.id}">✕</button></span>`
    ).join('') || '<span class="muted">Chưa lưu script nào</span>';
    $('scriptSaved').querySelectorAll('[data-load]').forEach((c) => {
      c.addEventListener('click', (ev) => {
        if (ev.target.dataset.del) return;
        const rec = (d.scripts || []).find((x) => x.id === Number(c.dataset.load));
        if (rec) {
          $('scriptLang').value = rec.language;
          $('scriptCode').value = rec.code || '';
        }
      });
    });
    $('scriptSaved').querySelectorAll('[data-del]').forEach((b) => {
      b.addEventListener('click', async (ev) => {
        ev.stopPropagation();
        try {
          await api(`/api/script?id=${b.dataset.del}`, { method: 'DELETE' });
          toast('Đã xóa script', 'ok');
          refreshScripts();
        } catch (e) { toast(e.message, 'err'); }
      });
    });
  } catch (e) {
    toast('Không tải được script: ' + e.message, 'err');
  }
}
$('scriptRun').addEventListener('click', async () => {
  const out = $('scriptOut');
  out.hidden = false;
  out.textContent = 'Đang chạy…';
  try {
    const r = await api('/api/script', {
      method: 'PUT',
      body: { run: true, language: $('scriptLang').value, code: $('scriptCode').value, timeoutMs: Number($('scriptTimeout').value) || 90000 },
    });
    out.textContent = `${r.success ? '✅' : '❌'} exit=${r.exitCode} — ${r.durationMs}ms${r.timedOut ? ' (TIMEOUT)' : ''}\n\n${r.output || r.message || '(không có output)'}`;
  } catch (e) {
    out.textContent = '❌ ' + e.message;
  }
});

// ---------- Selftest ----------
async function refreshSelftestInfo() {
  try {
    const d = await api('/api/selftest');
    const rt = d.runtime || {};
    const rows = [];
    if (rt.isWin) {
      rows.push(`<div><b>PowerShell</b> ${rt.powershellFound ? '✅ ' + esc(rt.powershellPath || '') : '❌ ' + esc(rt.powershellDetail || '')}</div>`);
      rows.push(`<div><b>Admin</b> ${rt.admin ? '✅ có quyền' : '❌ không có quyền Admin'}</div>`);
      rows.push(`<div><b>reg.exe</b> ${rt.regOk ? '✅ sẵn sàng' : '❌ thiếu'}</div>`);
    } else {
      rows.push(`<div><b>Nền tảng</b> ${esc(rt.platform)} — tinh chỉnh Windows chỉ chạy được trong bản .exe</div>`);
    }
    rows.push(`<div><b>Catalog</b> ${d.catalog.total} tinh chỉnh (${d.catalog.recommended} khuyến nghị, ${d.catalog.applied} đã áp dụng)</div>`);
    $('selftestRuntime').innerHTML = rows.join('');
    $('webhookMasked').textContent = d.webhook.configured ? `Webhook hiện tại: ${d.webhook.masked}` : 'Chưa cấu hình webhook Discord';
  } catch (e) {
    toast('Không đọc được trạng thái self-test: ' + e.message, 'err');
  }
}

$('webhookSave').addEventListener('click', async () => {
  try {
    await api('/api/selftest', { method: 'PUT', body: { webhookUrl: $('webhookUrl').value.trim() } });
    toast('Đã lưu webhook Discord', 'ok');
    refreshSelftestInfo();
  } catch (e) {
    toast('Lưu webhook lỗi: ' + e.message, 'err');
  }
});

async function runSelftest(mode) {
  try {
    toast(`Đang chạy self-test ${mode.toUpperCase()}…`);
    const r = await api('/api/selftest', { method: 'POST', body: { mode, webhook: false } });
    renderSelftestReport(r.report);
    if (r.report.webhook && r.report.webhook.detail) toast('Webhook: ' + r.report.webhook.detail, r.report.webhook.ok ? 'ok' : 'err');
  } catch (e) {
    toast('Self-test lỗi: ' + e.message, 'err');
  }
}
$('selftestCheck').addEventListener('click', () => runSelftest('check'));
$('selftestFull').addEventListener('click', () => {
  if (confirm('Chế độ FULL sẽ ÁP DỤNG rồi HOÀN TÁC từng tinh chỉnh trên hệ thống thật. Tiếp tục?')) runSelftest('full');
});

function renderSelftestReport(rep) {
  $('selftestReportCard').style.display = '';
  const counts = rep.counts || {};
  $('selftestSummary').innerHTML = `
    <div class="row-gap" style="margin-bottom:12px">
      <span class="badge ok">✅ ${counts.pass || 0}</span>
      <span class="badge err">❌ ${counts.fail || 0}</span>
      <span class="badge">⏭ ${counts.skipped || 0}</span>
      <span class="badge">${rep.durationMs}ms</span>
      <span class="badge">${rep.ok ? 'KẾT QUẢ ĐẠT' : 'CÓ LỖI'}</span>
    </div>`;
  const items = (rep.items || []).map((i) => `
    <div class="st-item">
      <span class="${i.skipped ? 'st-skip' : i.ok ? 'st-ok' : 'st-fail'}">${i.skipped ? '⏭' : i.ok ? '✅' : '❌'}</span>
      <div><div>${esc(i.name)}</div><div class="st-detail">${esc(i.detail)}</div></div>
      <span class="st-group">${esc(i.group)}</span>
    </div>`).join('');
  let fullHtml = '';
  if (rep.full) {
    fullHtml = '<h3 style="margin-top:14px">Chế độ full (apply → revert)</h3>' + rep.full.map((f) => `
      <div class="st-item">
        <span class="${f.skipped ? 'st-skip' : f.applyOk && f.revertOk ? 'st-ok' : 'st-fail'}">${f.skipped ? '⏭' : f.applyOk && f.revertOk ? '✅' : '❌'}</span>
        <div><div>${esc(f.name)}</div>
        <div class="st-detail">apply ${f.applyOk ? '✅' : '❌'} ${esc(f.applyMsg || '')}</div>
        <div class="st-detail">revert ${f.revertOk ? '✅' : '❌'} ${esc(f.revertMsg || '')}</div></div>
      </div>`).join('');
  }
  $('selftestItems').innerHTML = items + fullHtml;
}

// ---------- Screenshot ----------
async function refreshShots() {
  try {
    const d = await api('/api/screenshot');
    $('shotGrid').innerHTML = (d.shots || []).map((s) => `
      <div class="shot-item">
        <img src="${esc(s.url)}" alt="${esc(s.file)}" loading="lazy">
        <div class="shot-meta">
          <span>${esc(s.file)} — ${fmtBytes(s.sizeBytes)}</span>
          <button data-del="${esc(s.file)}" title="Xóa">🗑</button>
        </div>
      </div>`).join('') || '<p class="muted">Chưa có ảnh chụp nào</p>';
    $('shotGrid').querySelectorAll('[data-del]').forEach((b) => {
      b.addEventListener('click', async () => {
        try {
          await api(`/api/screenshot?file=${encodeURIComponent(b.dataset.del)}`, { method: 'DELETE' });
          refreshShots();
        } catch (e) { toast(e.message, 'err'); }
      });
    });
  } catch (e) {
    console.error(e);
  }
}

$('shotCapture').addEventListener('click', async () => {
  try {
    const data = await captureDashboardPng();
    await api('/api/screenshot', { method: 'POST', body: { data } });
    toast('Đã lưu ảnh chụp', 'ok');
    refreshShots();
  } catch (e) {
    toast('Chụp ảnh lỗi: ' + e.message, 'err');
  }
});

async function captureDashboardPng() {
  // Ưu tiên API chụp màn hình thật của WebView2 nếu có; fallback: chụp DOM bằng canvas
  const target = document.querySelector('.main');
  return new Promise((resolve, reject) => {
    importCanvasShot(target).then(resolve).catch(reject);
  });
}

async function importCanvasShot(el) {
  // Vẽ lại toàn bộ UI vào canvas bằng SVG foreignObject (không cần thư viện ngoài)
  const xml = new XMLSerializer().serializeToString(el);
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${el.scrollWidth}" height="${el.scrollHeight}">
    <foreignObject width="100%" height="100%">
      <div xmlns="http://www.w3.org/1999/xhtml" style="width:${el.scrollWidth}px;height:${el.scrollHeight}px">
        <style>body{background:#0b0e14;color:#e7ecf5;font-family:'Segoe UI',sans-serif}</style>
        ${xml}
      </div>
    </foreignObject>
  </svg>`;
  const img = new Image();
  img.src = 'data:image/svg+xml;base64,' + btoa(unescape(encodeURIComponent(svg)));
  await new Promise((r, j) => { img.onload = r; img.onerror = () => j(new Error('Không render được ảnh (ảnh ngoài/CORS)')); });
  const canvas = document.createElement('canvas');
  canvas.width = el.scrollWidth;
  canvas.height = el.scrollHeight;
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = '#0b0e14';
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.drawImage(img, 0, 0);
  return canvas.toDataURL('image/png');
}

// ---------- Backup ----------
async function refreshBackups() {
  try {
    const d = await api('/api/backup');
    $('backupTable').querySelector('tbody').innerHTML = (d.local || []).map((b) => `
      <tr><td>${esc(b.name)}</td><td class="num">${fmtBytes(b.sizeBytes)}</td><td class="muted">${new Date(b.createdAt).toLocaleString('vi-VN')}</td>
      <td><button class="btn danger" data-del="${esc(b.name)}">Xóa</button></td></tr>`).join('') || '<tr><td colspan="4" class="muted">Chưa có backup nào</td></tr>';
    $('backupTable').querySelectorAll('[data-del]').forEach((b) => {
      b.addEventListener('click', async () => {
        if (!confirm('Xóa backup ' + b.dataset.del + '?')) return;
        try {
          await api(`/api/backup?name=${encodeURIComponent(b.dataset.del)}`, { method: 'DELETE' });
          refreshBackups();
        } catch (e) { toast(e.message, 'err'); }
      });
    });
  } catch (e) {
    toast('Không đọc được backup: ' + e.message, 'err');
  }
}
$('backupCreate').addEventListener('click', async () => {
  try {
    const r = await api('/api/backup', { method: 'POST', body: { action: 'create' } });
    toast(r.message || 'Đã tạo backup', 'ok');
    refreshBackups();
  } catch (e) {
    toast('Backup lỗi: ' + e.message, 'err');
  }
});
$('backupOpen').addEventListener('click', async () => {
  try {
    const r = await api('/api/backup/open', { method: 'POST' });
    toast('Thư mục backup: ' + (r.folder || ''), 'ok');
  } catch (e) { toast(e.message, 'err'); }
});

// ---------- Settings ----------
let uiSettingsCache = null; // v3.4.0: cache settings — settingsSave echo lại background thay vì hardcode

// Áp dụng settings đã lưu NGAY khi mở app (accent/radius/petals) — không đợi mở tab Cài đặt
(async () => { try { const s0 = await api('/api/settings'); uiSettingsCache = s0; applyUiSettings(s0); } catch (_) {} })();

async function refreshSettings() {
  try {
    const s = await api('/api/settings');
    uiSettingsCache = s;
    $('setAccent').value = s.accent;
    $('setRadius').value = s.radius;
    $('setPetals').checked = !!s.petals;
    applyUiSettings(s);
    const sys = await api('/api/system');
    const rows = [];
    rows.push(`<div><b>Nền tảng</b> ${esc(sys.osRelease || sys.platform)}</div>`);
    if (sys.isWin) {
      rows.push(`<div><b>Quyền Admin</b> ${sys.admin ? '✅ có' : '❌ không'}</div>`);
      rows.push(`<div><b>App exe</b> ${esc(sys.appExe || '')}</div>`);
    } else {
      rows.push(`<div class="muted">${esc(sys.note || '')}</div>`);
    }
    $('settingsSystem').innerHTML = rows.join('');
  } catch (e) {
    toast('Không đọc được cài đặt: ' + e.message, 'err');
  }
}

function applyUiSettings(s) {
  document.documentElement.dataset.accent = s.accent;
  document.documentElement.style.setProperty('--radius', (s.radius || 1.25) + 'rem');
  const pt = document.querySelector('.petals'); // v3.4.0 fix: petals checkbox giờ có tác dụng thật
  if (pt) pt.style.display = s.petals === false ? 'none' : '';
}

$('settingsSave').addEventListener('click', async () => {
  try {
    const body = Object.assign({}, uiSettingsCache || {}, { // v3.4.1 fix: giữ lang/welcomeSeen
      accent: $('setAccent').value,
      background: uiSettingsCache?.background || 'sakura', // v3.4.0 fix: không ghi đè lựa chọn wallpaper
      customBgUrl: uiSettingsCache?.customBgUrl || '',
      radius: Number($('setRadius').value) || 1.25,
      petals: $('setPetals').checked,
    });
    const s = await api('/api/settings', { method: 'PUT', body });
    uiSettingsCache = s;
    applyUiSettings(s);
    toast('Đã lưu cài đặt', 'ok');
  } catch (e) {
    toast('Lưu cài đặt lỗi: ' + e.message, 'err');
  }
});

$('relaunchAdmin').addEventListener('click', async () => {
  if (!confirm('Mở lại Sakura Tool với quyền Administrator (UAC sẽ hiện)?')) return;
  try {
    const r = await api('/api/system', { method: 'POST', body: { action: 'relaunch-admin' } });
    toast(r.message || 'Đã yêu cầu nâng quyền', 'ok');
  } catch (e) {
    toast(e.message, 'err');
  }
});

// ---------- boot ----------
(async function boot() {
  try {
    const h = await api('/api/health');
    $('brandVersion').textContent = `Go edition • v${h.version}`;
    $('setVersion').textContent = 'v' + h.version;
    const sys = await api('/api/system');
    const badges = [];
    if (sys.isWin) {
      badges.push(`<span class="badge ${sys.admin ? 'ok' : 'err'}">${sys.admin ? '🛡️ Admin' : '👤 thường'}</span>`);
      badges.push(`<span class="badge ${sys.regOk ? 'ok' : 'err'}">reg.exe ${sys.regOk ? 'OK' : 'thiếu'}</span>`);
      badges.push(`<span class="badge ${sys.powershellFound ? 'ok' : 'err'}">PowerShell ${sys.powershellFound ? 'OK' : 'thiếu'}</span>`);
    }
    $('topBadges').innerHTML = badges.join('');
    showSection('overview');
  } catch (e) {
    toast('Không kết nối được app: ' + e.message, 'err');
  }
})();

// ---- Sakura welcome (lần đầu mở tool) ----
(function () {
  const ov = document.getElementById('welcomeOverlay');
  if (!ov || localStorage.getItem('sakura_welcome_seen') === '1') return;
  // v3.4.1 fix: server nhớ đã đồng ý → ẩn overlay (localStorage có thể trống khi origin đổi)
  fetch('/api/settings').then((r) => r.json()).then((s) => {
    if (s && s.welcomeSeen) {
      try { localStorage.setItem('sakura_welcome_seen', '1'); } catch (_) {}
      ov.style.display = 'none';
    }
  }).catch(() => {});
  ov.style.display = 'flex';
  fetch('/api/health').then((r) => r.json()).then((d) => {
    const v = document.getElementById('welcomeVer');
    if (v && d.version) v.textContent = d.version;
  }).catch(() => {});
  const agree = document.getElementById('welcomeAgree');
  const start = document.getElementById('welcomeStart');
  agree.addEventListener('change', () => { start.disabled = !agree.checked; });
  start.addEventListener('click', () => {
    localStorage.setItem('sakura_welcome_seen', '1');
    ov.style.display = 'none';
    // v3.4.1 fix: ghi nhớ lên server nữa — port đổi/clear cache vẫn không hỏi lại
    fetch('/api/settings').then((r) => r.json()).then((s) =>
      fetch('/api/settings', { method: 'PUT', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(Object.assign({}, s, { welcomeSeen: true })) })).catch(() => {});
  });
  document.getElementById('welcomeRestore').addEventListener('click', async () => {
    const msg = document.getElementById('welcomeRestoreMsg');
    msg.textContent = 'Đang tạo điểm khôi phục (có thể mất ~1 phút)…';
    try {
      const r = await fetch('/api/tweaks', { method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ids: ['sys-restore-point'], action: 'apply' }) }).then((x) => x.json());
      const res = (r.results && r.results[0]) || {};
      msg.textContent = res.success ? '✅ ' + res.message : '❌ ' + res.message;
    } catch (e) { msg.textContent = '❌ ' + e.message; }
  });
})();



// ===== Tự cập nhật: banner khi có bản release mới hơn bản đang chạy =====
(async () => {
  const bar = document.getElementById('updateBanner');
  if (!bar) return;
  try {
    const u = await fetch('/api/update').then((r) => r.json());
    if (u.available) {
      bar.style.display = 'block';
      bar.innerHTML = `🆕 Có bản mới <b>${esc(u.latest)}</b> — <button id="updGo" style="cursor:pointer;border:0;border-radius:6px;padding:4px 10px;font-weight:700;background:#a4133c;color:#fff">Cài ngay & tự mở lại</button>`;
      document.getElementById('updGo').onclick = async () => {
        await fetch('/api/update', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action: 'apply' }) });
        bar.innerHTML = '⬇️ Đang tải bản mới… tool sẽ <b>tự đóng và tự mở lại</b> (tối đa ~1 phút). Nếu 2 phút không thấy mở lại, hãy mở tool tay.';
      };
    }
  } catch (_) {}
})();

// ---------- Tìm kiếm 1000 tinh chỉnh (debounce 250ms) ----------
(() => {
  const inp = document.getElementById('tweakSearch');
  if (!inp) return;
  let tmr = null;
  inp.addEventListener('input', () => {
    clearTimeout(tmr);
    tmr = setTimeout(() => { tweakSearch = inp.value; tweakLimit = TWEAK_PAGE; renderTweaks(); }, 250);
  });
})();
