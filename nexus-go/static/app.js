/* NEXUS Optimizer — Go edition, app.js (vanilla, gọi cùng JSON API như bản cũ) */
'use strict';

const $ = (id) => document.getElementById(id);
const SECTION_META = {
  overview: ['Tổng quan', 'Giám sát CPU, RAM, Disk realtime'],
  cleanup: ['Dọn dẹp', 'Giải phóng RAM + Disk chỉ với một cú nhấp'],
  gaming: ['Gaming Mode', 'Tăng hiệu năng tối đa khi chơi game'],
  tweaks: ['Tinh chỉnh', 'Danh sách tối ưu xếp hạng theo độ ưu tiên'],
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
  return d.innerHTML;
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
    statsTimer = setInterval(refreshStats, 3000);
  } else if (name === 'cleanup') refreshCleanup();
  else if (name === 'gaming') refreshGaming();
  else if (name === 'tweaks') refreshTweaks();
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
  } catch (e) {
    console.error('stats', e);
  }
}

// ---------- Cleanup ----------
async function refreshCleanup() {
  try {
    const d = await api('/api/cleanup');
    $('cleanupRamNote').textContent = d.ramNote || '';
    const tbody = $('cleanupTargets').querySelector('tbody');
    tbody.innerHTML = (d.targets || []).map((t) => {
      const size = t.special ? '—' : fmtBytes(t.sizeBytes);
      const can = t.canClean ? '' : ' ⚠️';
      return `<tr><td>${esc(t.name)}${can}</td><td class="muted">${esc(t.path || '')}</td><td class="num">${size}</td><td class="muted">${esc(t.note || '')}</td></tr>`;
    }).join('');
    const logs = $('cleanupLogs').querySelector('tbody');
    logs.innerHTML = (d.logs || []).slice(0, 15).map((l) =>
      `<tr><td class="muted">${new Date(l.createdAt).toLocaleString('vi-VN')}</td><td>${esc(l.kind)}</td><td>${esc(l.target)}</td><td class="num">${l.freedBytes > 0 ? fmtBytes(l.freedBytes) : '—'}</td><td class="${l.success ? 'st-ok' : 'st-fail'}">${l.success ? '✅' : '❌'} ${esc(l.message || '')}</td></tr>`
    ).join('') || '<tr><td colspan="5" class="muted">Chưa có log nào</td></tr>';
  } catch (e) {
    toast('Không quét được mục tiêu dọn dẹp: ' + e.message, 'err');
  }
}

async function runCleanup(action, busyId) {
  setBusy(busyId, 'Đang chạy…');
  try {
    const r = await api('/api/cleanup', { method: 'POST', body: { action } });
    const lines = (r.results || []).map((x) => `${x.success ? '✅' : '❌'} ${x.name}: ${x.message}`);
    $('cleanupResultsCard').style.display = '';
    $('cleanupResults').innerHTML = lines.map((l) => `<div class="muted">${esc(l)}</div>`).join('');
    toast(`Dọn xong — disk giải phóng ${fmtBytes(r.totalFreedDisk || 0)}, RAM ${fmtBytes(r.totalFreedRam || 0)}`, r.totalFreedDisk + r.totalFreedRam > 0 ? 'ok' : '');
    refreshCleanup();
  } catch (e) {
    toast('Dọn dẹp lỗi: ' + e.message, 'err');
  } finally {
    setBusy(busyId, '');
  }
}
$('cleanupDisk').addEventListener('click', () => runCleanup('disk', 'cleanupBusy'));
$('cleanupRam').addEventListener('click', () => runCleanup('ram', 'cleanupBusy'));
$('cleanupAll').addEventListener('click', () => runCleanup('all', 'cleanupBusy'));

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

function renderTweaks() {
  const list = $('tweakList');
  const items = tweaksCache.filter((t) => tweakFilter === 'all' || t.category === tweakFilter);
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
      renderTweaks();
    });
  });
}

document.querySelectorAll('#tweakFilters .chip').forEach((chip) => {
  chip.addEventListener('click', () => {
    document.querySelectorAll('#tweakFilters .chip').forEach((c) => c.classList.remove('active'));
    chip.classList.add('active');
    tweakFilter = chip.dataset.cat;
    renderTweaks();
  });
});

async function runTweaks(ids, action) {
  if (!ids.length) return toast('Chưa chọn mục nào', 'err');
  setBusy('tweaksBusy', `Đang ${action === 'apply' ? 'áp dụng' : 'hoàn tác'} ${ids.length} mục…`);
  try {
    const r = await api('/api/tweaks', { method: 'POST', body: { ids, action } });
    const fails = (r.results || []).filter((x) => !x.success);
    const failsMsg = fails.length ? ` — ${fails.length} mục lỗi (xem chi tiết trong danh sách)` : '';
    toast(`${action === 'apply' ? 'Áp dụng' : 'Hoàn tác'} xong${failsMsg}`, fails.length ? 'err' : 'ok');
    selectedTweaks.clear();
    refreshTweaks();
  } catch (e) {
    toast('Chạy tinh chỉnh lỗi: ' + e.message, 'err');
  } finally {
    setBusy('tweaksBusy', '');
  }
}
$('tweaksApplySel').addEventListener('click', () => runTweaks([...selectedTweaks], 'apply'));
$('tweaksRevertSel').addEventListener('click', () => runTweaks([...selectedTweaks], 'revert'));
$('tweaksSelAll').addEventListener('click', () => {
  tweaksCache.forEach((t) => selectedTweaks.add(t.id));
  renderTweaks();
});
$('tweaksSelNone').addEventListener('click', () => {
  selectedTweaks.clear();
  renderTweaks();
});

// ---------- Processes ----------
async function refreshProcesses() {
  try {
    const d = await api('/api/processes');
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
    toast('Không đọc được tiến trình: ' + e.message, 'err');
  }
}
$('procRefresh').addEventListener('click', refreshProcesses);
$('procSearch').addEventListener('input', refreshProcesses);

// ---------- Network ----------
async function refreshNetwork() {
  try {
    const d = await api('/api/network');
    $('netIfaces').innerHTML = (d.ifaces || []).map((i) =>
      `<div><b>${esc(i.name)}</b> ${i.ipv4.map(esc).join(', ')} ${i.mac ? `<span class="muted">${esc(i.mac)}</span>` : ''}</div>`
    ).join('') || '<div class="muted">Không có giao diện nào</div>';
    $('netPorts').innerHTML = (d.ports || []).map((p) =>
      `<span class="chip" style="cursor:default">${p.port}<span class="muted">/${p.proto}</span></span>`
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
    $('scriptLang').innerHTML = (d.languages || []).map((l) => `<option value="${l}">${l}</option>`).join('');
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
async function refreshSettings() {
  try {
    const s = await api('/api/settings');
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
}

$('settingsSave').addEventListener('click', async () => {
  try {
    const body = {
      accent: $('setAccent').value,
      background: 'sakura',
      customBgUrl: '',
      radius: Number($('setRadius').value) || 1.25,
      petals: $('setPetals').checked,
    };
    const s = await api('/api/settings', { method: 'PUT', body });
    applyUiSettings(s);
    toast('Đã lưu cài đặt', 'ok');
  } catch (e) {
    toast('Lưu cài đặt lỗi: ' + e.message, 'err');
  }
});

$('relaunchAdmin').addEventListener('click', async () => {
  if (!confirm('Mở lại NEXUS Optimizer với quyền Administrator (UAC sẽ hiện)?')) return;
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
    $('brandVersion').textContent = `Go edition v${h.version}`;
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
