/* Sakura Tool — wallpaper.js
 * Card "🖼️ Hình nền" cho section Cài đặt (#sec-settings).
 * - Tự chứa IIFE, không đụng app.js / index.html / style.css (inject <style> + 1 card).
 * - Lưu server: GET /api/settings → merge → PUT /api/settings (debounce 400ms, lỗi im lặng).
 *   → app.js có HARD-CODE background:'sakura' khi bấm "Lưu cài đặt": file này vẫn đúng vì
 *     localStorage 'sakura-wallpaper' là nguồn truth hiển thị; server sync chỉ best-effort.
 * - Lưu local: localStorage['sakura-wallpaper'] = JSON {bg, opacity, random, customUrl}.
 * - Layer nền: body::before position:fixed inset:0 z-index:-1 (html không có background nên
 *   background của body propagate xuống canvas ⇒ ::before -1 vẽ TRÊN nền gốc, DƯỚI .petals
 *   (z-index:0) và .layout (z-index:1) ⇒ không phá nội dung, không đè cánh hoa).
 * - Value 'sakura' = mặc định: remove class ⇒ ::before ẩn, CSS gradient gốc của style.css sống lại.
 */
(function () {
  'use strict';

  var LS_KEY = 'sakura-wallpaper';
  var OPACITY_DEFAULT = 45; // %, khớp overlay mặc định
  var OPACITY_MAX = 90;

  /* ---- Bảng ánh xạ value (server `background`) -> ảnh trong /img/ ----
   * Manager cần thêm các key sau vào backgroundKeys (store.go):
   *   sakura-bg, sakura-bg2, sakura-gaming, sakura-hero,
   *   bg-ai-night, bg-ai-sunset, bg-ai-petals
   * ('sakura' và 'custom' đã có sẵn trong backgroundKeys.)
   * Ảnh AI chưa có file trên đĩa vẫn hiện option; thumbnail lỗi (onerror) sẽ ẩn option.
   */
  var WALLPAPERS = [
    { value: 'sakura',        name: 'Mặc định',  img: null,                    thumb: 'grad'   },
    { value: 'sakura-bg',     name: 'Sakura',    img: '/img/sakura-bg.jpg',    thumb: '/img/sakura-bg.jpg' },
    { value: 'sakura-bg2',    name: 'Sakura Alt',img: '/img/sakura-bg2.jpg',   thumb: '/img/sakura-bg2.jpg' },
    { value: 'sakura-gaming', name: 'Gaming',    img: '/img/sakura-gaming.jpg',thumb: '/img/sakura-gaming.jpg' },
    { value: 'sakura-hero',   name: 'Hero',      img: '/img/sakura-hero.jpg',  thumb: '/img/sakura-hero.jpg' },
    { value: 'bg-ai-night',   name: 'AI Night',  img: '/img/bg-ai-night.jpg',  thumb: '/img/bg-ai-night.jpg' },
    { value: 'bg-ai-sunset',  name: 'AI Sunset', img: '/img/bg-ai-sunset.jpg', thumb: '/img/bg-ai-sunset.jpg' },
    { value: 'bg-ai-petals',  name: 'AI Petals', img: '/img/bg-ai-petals.jpg', thumb: '/img/bg-ai-petals.jpg' },
    { value: 'custom',        name: 'Custom URL',img: null,                    thumb: 'custom' }
  ];

  var VALUES = {};
  WALLPAPERS.forEach(function (w) { VALUES[w.value] = true; });

  // Pool cho chế độ ngẫu nhiên: chỉ các ảnh có sẵn, KHÔNG gồm 'sakura' (Mặc định) và 'custom'.
  var RANDOM_POOL = WALLPAPERS.filter(function (w) {
    return w.img && w.value !== 'custom';
  }).map(function (w) { return w.value; });

  var state = { bg: 'sakura', opacity: OPACITY_DEFAULT, random: false, customUrl: '' };
  var failedImages = {};   // value -> true khi thumbnail lỗi (file chưa tồn tại)
  var randomPick = null;   // ảnh được chọn ngẫu nhiên cho phiên load trang này
  var saveTimer = null;
  var urlInput = null;

  function byId(id) { return document.getElementById(id); }

  /* ---------- localStorage ---------- */
  function persist() {
    try {
      localStorage.setItem(LS_KEY, JSON.stringify({
        bg: state.bg,
        opacity: state.opacity,
        random: state.random,
        customUrl: state.customUrl
      }));
    } catch (e) { /* lưu local lỗi thì bỏ qua */ }
  }

  function loadLocal() {
    var raw = null;
    try { raw = JSON.parse(localStorage.getItem(LS_KEY) || 'null'); } catch (e) { raw = null; }
    if (!raw || typeof raw !== 'object') return false;
    if (typeof raw.bg === 'string' && VALUES[raw.bg]) state.bg = raw.bg;
    var op = Number(raw.opacity);
    if (isFinite(op)) state.opacity = Math.min(OPACITY_MAX, Math.max(0, Math.round(op)));
    state.random = !!raw.random;
    if (typeof raw.customUrl === 'string') state.customUrl = raw.customUrl;
    return true;
  }

  /* ---------- helper ---------- */
  function isValidCustomUrl(u) {
    return /^https?:\/\//i.test(u) || /^data:image\//i.test(u);
  }

  function escForCssUrl(u) {
    return String(u).replace(/\\/g, '\\\\').replace(/"/g, '%22');
  }

  function escHtml(s) {
    return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }

  function toastErr(msg) {
    if (typeof window.toast === 'function') { window.toast(msg, 'err'); return; }
    // Fallback mini-toast (app.js chưa load / bị đổi tên)
    var el = document.createElement('div');
    el.textContent = msg;
    el.style.cssText = 'position:fixed;top:16px;right:16px;z-index:9999;background:rgba(46,24,43,.96);' +
      'border:1px solid rgba(255,143,181,.22);border-left:3px solid #f87171;color:#fdeaf3;' +
      'padding:11px 15px;border-radius:10px;font:13.5px "Segoe UI",sans-serif;max-width:420px;' +
      'box-shadow:0 8px 24px rgba(0,0,0,.45)';
    document.body.appendChild(el);
    setTimeout(function () { el.remove(); }, 5000);
  }

  /* ---------- sync server (best-effort, im lặng) ---------- */
  function scheduleSave() {
    clearTimeout(saveTimer);
    saveTimer = setTimeout(function () {
      fetch('/api/settings')
        .then(function (r) { if (!r.ok) throw new Error('GET ' + r.status); return r.json(); })
        .then(function (s) {
          var body = Object.assign({}, s, {
            background: state.bg,
            customBgUrl: state.bg === 'custom' ? state.customUrl : ''
          });
          return fetch('/api/settings', {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(body)
          });
        })
        .catch(function () { /* im lặng: server lỗi / chưa patch ValidateSettings */ });
    }, 400);
  }

  /* ---------- áp dụng nền (layer ::before, không đụng inline body background) ---------- */
  function pickRandom() {
    var pool = RANDOM_POOL.filter(function (v) { return !failedImages[v]; });
    if (!pool.length) return 'sakura';
    return pool[Math.floor(Math.random() * pool.length)];
  }

  function applyWallpaper() {
    var body = document.body;
    if (!body) return;
    var bg = (state.random && randomPick) ? randomPick : state.bg;
    var url = null;

    if (bg === 'custom') {
      if (state.customUrl && isValidCustomUrl(state.customUrl)) url = state.customUrl;
    } else if (bg !== 'sakura') {
      var w = WALLPAPERS.filter(function (x) { return x.value === bg; })[0];
      if (w && w.img) url = w.img;
    }

    if (!url) {
      // 'sakura' (Mặc định) hoặc custom chưa hợp lệ ⇒ restore CSS gốc của style.css.
      body.classList.remove('sakura-wp-on');
      body.style.removeProperty('--wp-img');
      body.style.removeProperty('--wp-op');
    } else {
      body.classList.add('sakura-wp-on');
      body.style.setProperty('--wp-img', 'url("' + escForCssUrl(url) + '")');
      body.style.setProperty('--wp-op', (state.opacity / 100).toFixed(2));
    }
    markActive(bg);
  }

  function markActive(applied) {
    var card = byId('wallpaperCard');
    if (!card) return;
    var opts = card.querySelectorAll('.wp-opt');
    for (var i = 0; i < opts.length; i++) {
      var on = opts[i].getAttribute('data-wp') === applied && opts[i].style.display !== 'none';
      opts[i].classList.toggle('active', !!on);
    }
  }

  /* ---------- inject style + card ---------- */
  function injectStyle() {
    var css = [
      /* Layer nền: z-index -1 nằm TRÊN canvas background (body bg propagate vì html không có bg)
         và DƯỚI .petals (z-index:0) + .layout (z-index:1) ⇒ nội dung + cánh hoa không bị che. */
      'body.sakura-wp-on::before {',
      '  content: \'\';',
      '  position: fixed;',
      '  inset: 0;',
      '  z-index: -1;',
      '  pointer-events: none;',
      '  background-color: #150a15;',
      '  background-image: linear-gradient(rgba(8,6,14,var(--wp-op,.45)), rgba(8,6,14,var(--wp-op,.45))), var(--wp-img, none);',
      '  background-size: cover;',
      '  background-position: center;',
      '  background-repeat: no-repeat;',
      '  background-attachment: fixed;',
      '}',
      '.wp-grid { display: flex; flex-wrap: wrap; gap: 10px; margin: 6px 0 16px; }',
      '.wp-opt { width: 150px; cursor: pointer; display: flex; flex-direction: column; gap: 5px;',
      '  padding: 5px; border-radius: 10px; border: 2px solid var(--border, rgba(255,143,181,.22));',
      '  background: rgba(0,0,0,.22); transition: border-color .15s ease, box-shadow .15s ease; }',
      '.wp-opt:hover { border-color: var(--accent, #ff8fb5); }',
      '.wp-opt.active { border-color: var(--accent, #ff8fb5);',
      '  box-shadow: 0 0 0 1px var(--accent, #ff8fb5), 0 4px 14px rgba(255,126,182,.25); }',
      '.wp-thumb { width: 100%; height: 84px; border-radius: 7px; overflow: hidden; display: block;',
      '  background: #150a15; }',
      '.wp-thumb img { width: 100%; height: 100%; object-fit: cover; display: block; }',
      '.wp-thumb-grad { background: linear-gradient(160deg, #3a1e38 0%, #150a15 55%, #1c0f1c 100%); }',
      '.wp-thumb-custom { display: flex; align-items: center; justify-content: center; font-size: 30px;',
      '  border: 1px dashed var(--border, rgba(255,143,181,.22)); background: rgba(0,0,0,.3); }',
      '.wp-name { font-size: 12.5px; color: var(--text, #fdeaf3); text-align: center; padding-bottom: 2px;',
      '  white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }',
      '.wp-row { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; margin: 0 0 8px; }',
      '.wp-slider { flex: 1; min-width: 180px; max-width: 320px; accent-color: var(--accent, #ff8fb5); }',
      '.wp-opval { min-width: 44px; font-weight: 700; color: var(--accent, #ff8fb5); }',
      '.wp-custom-row { display: flex; align-items: center; gap: 8px; margin-top: 4px; }',
      '.wp-custom-row .input { flex: 1; min-width: 200px; }'
    ].join('\n');

    var style = document.createElement('style');
    style.id = 'sakuraWpStyle';
    style.textContent = css;
    (document.head || document.documentElement).appendChild(style);
  }

  function buildCardHtml() {
    var cards = WALLPAPERS.map(function (w) {
      var thumb;
      if (w.thumb === 'grad') {
        thumb = '<div class="wp-thumb wp-thumb-grad"></div>';
      } else if (w.thumb === 'custom') {
        thumb = '<div class="wp-thumb wp-thumb-custom">🔗</div>';
      } else {
        thumb = '<div class="wp-thumb"><img src="' + w.thumb + '" alt="' + escHtml(w.name) + '" loading="lazy"></div>';
      }
      return '<div class="wp-opt" data-wp="' + w.value + '" role="button" tabindex="0" title="' + escHtml(w.name) + '">' +
        thumb + '<div class="wp-name">' + escHtml(w.name) + '</div></div>';
    }).join('');

    return '' +
      '<div class="card" id="wallpaperCard">' +
      '  <h3>🖼️ Hình nền</h3>' +
      '  <div class="wp-grid" id="wpOptions">' + cards + '</div>' +
      '  <div class="wp-row">' +
      '    <label for="wpOpacity" style="color:var(--muted);font-size:13px;">Lớp phủ tối</label>' +
      '    <input type="range" id="wpOpacity" class="wp-slider" min="0" max="' + OPACITY_MAX + '" step="1" value="' + OPACITY_DEFAULT + '">' +
      '    <span class="wp-opval" id="wpOpacityVal">' + OPACITY_DEFAULT + '%</span>' +
      '  </div>' +
      '  <label class="check"><input type="checkbox" id="wpRandom"> Ngẫu nhiên mỗi lần mở</label>' +
      '  <div class="wp-custom-row">' +
      '    <input type="text" id="wpCustomUrl" class="input" placeholder="https://…/anh.jpg hoặc data:image/…" spellcheck="false" autocomplete="off">' +
      '    <span class="muted" style="white-space:nowrap;">dùng khi chọn Custom URL</span>' +
      '  </div>' +
      '  <p class="muted">Thay đổi được áp dụng và lưu tự động — không cần bấm nút.</p>' +
      '</div>';
  }

  /* ---------- wire events ---------- */
  function wire() {
    var card = byId('wallpaperCard');
    if (!card) return;
    var grid = byId('wpOptions');
    urlInput = byId('wpCustomUrl');
    var slider = byId('wpOpacity');
    var opVal = byId('wpOpacityVal');
    var randomCb = byId('wpRandom');

    urlInput.value = state.customUrl;
    slider.value = String(state.opacity);
    opVal.textContent = state.opacity + '%';
    randomCb.checked = state.random;

    // Chọn option (radio-style). Nếu random đang bật: áp ảnh chọn ngay cho phiên này,
    // random giữ nguyên (lần mở trang sau lại ngẫu nhiên).
    function selectOption(value) {
      state.bg = value;
      if (value === 'custom') {
        if (urlInput.value && isValidCustomUrl(urlInput.value)) {
          state.customUrl = urlInput.value.trim();
        }
        if (!(state.customUrl && isValidCustomUrl(state.customUrl))) {
          toastErr('URL hình nền không hợp lệ — phải bắt đầu bằng http(s):// hoặc data:image/');
        }
        try { urlInput.focus(); } catch (e) { /* webview cũ */ }
      }
      persist();
      applyWallpaper();
      scheduleSave();
    }

    grid.addEventListener('click', function (ev) {
      var opt = ev.target.closest('.wp-opt');
      if (opt && opt.style.display !== 'none') selectOption(opt.getAttribute('data-wp'));
    });
    grid.addEventListener('keydown', function (ev) {
      if (ev.key !== 'Enter' && ev.key !== ' ') return;
      var opt = ev.target.closest('.wp-opt');
      if (opt) { ev.preventDefault(); selectOption(opt.getAttribute('data-wp')); }
    });

    // Thumbnail lỗi (file chưa có, vd ảnh AI chưa add) ⇒ ẩn option, khỏi pool random,
    // và nếu ảnh đó đang là random pick thì chọn lại.
    Array.prototype.forEach.call(grid.querySelectorAll('.wp-thumb img'), function (img) {
      img.addEventListener('error', function () {
        var opt = img.closest('.wp-opt');
        if (!opt) return;
        var v = opt.getAttribute('data-wp');
        failedImages[v] = true;
        opt.style.display = 'none';
        if (randomPick === v) { randomPick = pickRandom(); applyWallpaper(); }
      });
    });

    slider.addEventListener('input', function () {
      state.opacity = Number(slider.value) || 0;
      opVal.textContent = state.opacity + '%';
      persist();
      applyWallpaper();
      scheduleSave(); // đổi slider cũng đồng bộ background hiện tại lên server
    });

    randomCb.addEventListener('change', function () {
      state.random = randomCb.checked;
      if (state.random) randomPick = pickRandom(); // áp ngay 1 ảnh ngẫu nhiên để thấy hiệu ứng
      persist();
      applyWallpaper();
      scheduleSave();
    });

    // Gõ URL custom: hợp lệ thì áp NGAY; sai chỉ toast khi blur/Enter (không spam mỗi phím)
    urlInput.addEventListener('input', function () {
      var v = urlInput.value.trim();
      state.customUrl = v;
      persist();
      if (state.bg === 'custom' && v && isValidCustomUrl(v)) applyWallpaper();
      if (state.bg === 'custom') scheduleSave();
    });
    urlInput.addEventListener('change', function () {
      var v = urlInput.value.trim();
      if (state.bg === 'custom' && v && !isValidCustomUrl(v)) {
        toastErr('URL hình nền không hợp lệ — phải bắt đầu bằng http(s):// hoặc data:image/');
      }
    });
  }

  /* ---------- init ---------- */
  function init() {
    if (byId('wallpaperCard')) return; // đã inject (double-load guard)
    var anchor = document.querySelector('#sec-settings .card'); // card "Giao diện" đầu tiên
    if (!anchor || !anchor.parentNode) return;
    injectStyle();
    anchor.insertAdjacentHTML('beforebegin', buildCardHtml());

    var hasLocal = loadLocal();
    if (hasLocal) {
      // localStorage là nguồn truth ⇒ không bị app.js hardcode background:'sakura' làm mất chọn.
      if (state.random) randomPick = pickRandom();
      wire();
      applyWallpaper();
    } else {
      wire();
      applyWallpaper(); // mặc định tạm (sakura) trong lúc chờ server
      fetch('/api/settings')
        .then(function (r) { return r.ok ? r.json() : null; })
        .then(function (s) {
          if (!s) return;
          if (typeof s.background === 'string' && VALUES[s.background]) state.bg = s.background;
          if (typeof s.customBgUrl === 'string') state.customUrl = s.customBgUrl;
          if (urlInput) urlInput.value = state.customUrl;
          if (state.random) randomPick = pickRandom();
          persist();
          applyWallpaper();
        })
        .catch(function () { /* server lỗi ⇒ giữ mặc định */ });
    }
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
