const CLIENT_ID = "1563917712227442731";
const API = "https://discord.com/api/v10";
const SCOPES = "openid sdk.social_layer_presence";

const BASE = { type: "0", timer: "auto", image: "preview", smallImage: "", smallText: "", b1l: "", b1u: "", b2l: "", b2u: "" };
const DEFAULTS = {
  video: { ...BASE, name: "Video", details: "đang xem 📺", state: "", imageText: "đang xem" },
  music: { ...BASE, name: "Nhạc", details: "đang nghe nhạc 🎧", state: "", imageText: "đang nghe nhạc" },
};
const DEF_RULES = { video: true, music: true };

const b64url = (buf) =>
  btoa(String.fromCharCode(...new Uint8Array(buf)))
    .replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

async function tokenRequest(params) {
  const res = await fetch(`${API}/oauth2/token`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ client_id: CLIENT_ID, ...params }),
  });
  if (!res.ok) throw new Error("Discord từ chối đăng nhập: " + (await res.text()));
  const j = await res.json();
  const auth = {
    access_token: j.access_token,
    refresh_token: j.refresh_token,
    expires_at: Date.now() + j.expires_in * 1000,
  };
  await chrome.storage.local.set({ auth });
  return auth;
}

const REDIRECT = `https://${chrome.runtime.id}.chromiumapp.org/`;
const finishing = new Set();

async function login(silent = false) {
  const verifier = b64url(crypto.getRandomValues(new Uint8Array(32)));
  const challenge = b64url(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier)));
  const state = b64url(crypto.getRandomValues(new Uint8Array(16)));
  const url = "https://discord.com/oauth2/authorize?" + new URLSearchParams({
    client_id: CLIENT_ID, response_type: "code", redirect_uri: REDIRECT,
    scope: SCOPES, state, code_challenge: challenge, code_challenge_method: "S256", ...(silent && { prompt: "none" }),
  });
  const tab = await chrome.tabs.create({ url, active: !silent });
  await chrome.storage.local.set({ pending: { verifier, state, tabId: tab.id, silent }, loginError: null });
}

async function finishLogin(tabId, urlStr) {
  if (finishing.has(tabId)) return;
  const { pending } = await chrome.storage.local.get("pending");
  if (!pending || pending.tabId !== tabId) return;
  finishing.add(tabId);
  await chrome.storage.local.remove("pending");
  chrome.tabs.remove(tabId).catch(() => {});
  try {
    const q = new URL(urlStr).searchParams;
    if (q.get("state") !== pending.state || !q.get("code")) throw new Error("Đăng nhập bị hủy hoặc lỗi: " + (q.get("error_description") || q.get("error") || "") + " [scope đang dùng: " + SCOPES + "]");
    const auth = await tokenRequest({
      grant_type: "authorization_code", code: q.get("code"),
      redirect_uri: REDIRECT, code_verifier: pending.verifier,
    });
    let name = "OK";
    try {
      const me = await (await fetch(`${API}/oauth2/userinfo`, { headers: { Authorization: `Bearer ${auth.access_token}` } })).json();
      name = me.global_name || me.preferred_username || me.username || "OK";
    } catch (_) {}
    await chrome.storage.local.set({ user: name, loginError: null });
    const { enabled } = await chrome.storage.local.get("enabled");
    if (enabled) startActivity().catch(console.error);
    badge();
  } catch (e) {
    await chrome.storage.local.set({ loginError: String(e.message || e) });
    if (pending.silent) {
      chrome.action.setBadgeText({ text: "!" });
      chrome.action.setBadgeBackgroundColor({ color: "#da373c" });
      await login(false);
    }
  } finally { finishing.delete(tabId); }
}

chrome.tabs.onUpdated.addListener((tabId, info, tab) => {
  const u = info.url || tab.url;
  if (u && u.startsWith(REDIRECT)) finishLogin(tabId, u);
});

async function getAccessToken() {
  const { auth } = await chrome.storage.local.get("auth");
  if (!auth) throw new Error("Chưa đăng nhập Discord");
  if (auth.expires_at - Date.now() > 60000) return auth.access_token;
  return (await tokenRequest({ grant_type: "refresh_token", refresh_token: auth.refresh_token })).access_token;
}

async function resolveImage(img) {
  if (!img || /^(https?:|mp:)/.test(img) || /^\d+$/.test(img)) return img;
  try {
    const r = await fetch(`${API}/oauth2/applications/${CLIENT_ID}/assets`);
    const list = await r.json();
    const a = Array.isArray(list) && list.find((x) => x.name === img);
    if (a) return a.id;
  } catch (_) {}
  return img;
}

async function startActivityInner() {
  const st = await chrome.storage.local.get(["cfgs", "auto", "mode", "session", "startedAt", "mediaKey", "mediaStart", "mediaEnd", "mediaPaused", "mediaInfo"]);
  const { session, startedAt } = st;
  const cfgs = { ...DEFAULTS, ...(st.cfgs || {}) };
  const curMode = st.mode || "none";
  const cfg = cfgs[curMode] || cfgs.music;
  // Kiểu PreMiD: không phát nhạc/video thì không hiện gì (xóa presence), nhưng vẫn giữ extension ở trạng thái BẬT để tự hiện lại khi có nhạc
  if ((curMode !== "music" && curMode !== "video") || cfg.hide) {
    await deleteSession();
    await chrome.storage.local.set({ enabled: true });
    badge();
    await chrome.alarms.create("keepalive", { periodInMinutes: 10 });
    await chrome.alarms.create("tick", { periodInMinutes: 0.5 });
    return;
  }
  const activity = {
    application_id: CLIENT_ID,
    name: cfg.name || DEFAULTS.name,
    platform: "desktop",
    type: Number(cfg.type || 0),
    details: cfg.details || undefined,
    state: cfg.state || undefined,
  };
  const large = await resolveImage(cfg.image), small = await resolveImage(cfg.smallImage);
  if (large || small) {
    activity.assets = {
      ...(large && { large_image: large, large_text: cfg.imageText || undefined }),
      ...(small && { small_image: small, small_text: cfg.smallText || undefined }),
    };
  }
  const mi = st.mediaInfo;
  if ((curMode === "music" || curMode === "video") && mi && mi.title) {
    activity.type = curMode === "music" ? 2 : 3;
    activity.details = mi.title.slice(0, 128);
    activity.state = ((st.mediaPaused ? "⏸ " : "") + (mi.artist || cfg.name)).slice(0, 128);
    activity.assets = { large_image: mi.art || large, large_text: mi.title.slice(0, 128), ...(large && mi.art && { small_image: large, small_text: cfg.name }) };
    if (st.mediaStart && !st.mediaPaused) activity.timestamps = { start: Math.round(st.mediaStart), ...(st.mediaEnd ? { end: Math.round(st.mediaEnd) } : {}) };
  }
  if (cfg.timer === "since" && !activity.timestamps) activity.timestamps = { start: startedAt || Date.now() };
  const buttons = [[cfg.b1l, cfg.b1u], [cfg.b2l, cfg.b2u]]
    .filter(([l, u]) => l && /^https?:\/\//.test(u || ""))
    .map(([label, url]) => ({ label: label.slice(0, 32), url }));
  if (buttons.length) activity.buttons = buttons;
  const post = async (token, sess) =>
    fetch(`${API}/users/@me/headless-sessions`, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify({ activities: [activity], ...(sess && { token: sess }) }),
    });
  let res = await post(await getAccessToken(), session);
  if (res.status === 401) {
    const { auth } = await chrome.storage.local.get("auth");
    res = await post((await tokenRequest({ grant_type: "refresh_token", refresh_token: auth.refresh_token })).access_token, session);
  }
  if (res.status === 400 && session) {
    await chrome.storage.local.set({ session: null });
    res = await post(await getAccessToken(), null);
  }
  if (!res.ok) {
    const body = await res.text();
    if (body.includes("50014")) throw new Error("Phiên đăng nhập Discord hết hạn hoặc bị thu hồi. Bấm Đăng nhập Discord lại rồi Bật status.");
    throw new Error(`Discord báo lỗi ${res.status}: ${body}`);
  }
  const j = await res.json();
  await chrome.storage.local.set({ session: j.token, enabled: true });
  badge();
  await chrome.alarms.create("keepalive", { periodInMinutes: 10 });
  await chrome.alarms.create("tick", { periodInMinutes: 0.5 });
}

async function startActivity() {
  try { await startActivityInner(); }
  catch (e) {
    if (/50014|invalid_grant|Phiên đăng nhập|Chưa đăng nhập/.test(String(e.message))) {
      const { lastRelogin } = await chrome.storage.local.get("lastRelogin");
      if (!lastRelogin || Date.now() - lastRelogin > 600000) { await chrome.storage.local.set({ lastRelogin: Date.now() }); login(true).catch(console.error); }
    }
    throw e;
  }
}

async function stopActivity() {
  const { session } = await chrome.storage.local.get("session");
  await chrome.alarms.clear("keepalive");
  await chrome.alarms.clear("tick");
  await chrome.storage.local.set({ enabled: false, session: null });
  badge();
  if (!session) return;
  try {
    await fetch(`${API}/users/@me/headless-sessions/delete`, {
      method: "POST",
      headers: { Authorization: `Bearer ${await getAccessToken()}`, "Content-Type": "application/json" },
      body: JSON.stringify({ token: session }),
    });
  } catch (_) {}
}

chrome.alarms.onAlarm.addListener(async (a) => {
  if (a.name === "tick") return syncNow();
  if (a.name !== "keepalive") return;
  const { enabled } = await chrome.storage.local.get("enabled");
  if (enabled) { await refreshMode(); startActivity().catch(console.error); }
});

chrome.runtime.onStartup.addListener(async () => {
  const { enabled } = await chrome.storage.local.get("enabled");
  if (enabled) { await refreshMode(); startActivity().catch(console.error); }
});

chrome.runtime.onMessage.addListener((msg, _s, send) => {
  (async () => {
    try {
      if (msg.type === "login") await login();
      else if (msg.type === "start") { await chrome.storage.local.set({ cfgs: msg.cfgs, auto: msg.auto, rules: msg.rules, startedAt: Date.now() }); await refreshMode(); await startActivity(); }
      else if (msg.type === "stop") await stopActivity();
      send({ ok: true });
    } catch (e) { send({ ok: false, error: String(e.message || e) }); }
  })();
  return true;
});

const DISCORD_RE = /^https:\/\/([\w-]+\.)?discord\.com\//;
const MUSIC_HOSTS = ["music.youtube.com", "open.spotify.com", "soundcloud.com", "zingmp3.vn", "nhaccuatui.com", "youtu.be", "music.apple.com", "deezer.com", "tidal.com", "bandcamp.com", "music.amazon.com"];
const VIDEO_HOSTS = ["netflix.com", "twitch.tv", "tiktok.com", "bilibili.com", "disneyplus.com", "primevideo.com", "fptplay.vn"];

function classify(u) {
  try {
    const x = new URL(u), h = x.hostname.replace(/^(www|m)\./, ""), p = x.pathname;
    const hit = (a) => a.some((d) => h === d || h.endsWith("." + d));
    if (hit(MUSIC_HOSTS)) return "music";
    if (hit(VIDEO_HOSTS)) return "video";
    if (h === "youtube.com") {
      if (p.startsWith("/live")) return "video";
      // YouTube /watch = nghe nhạc. /shorts bỏ hẳn (không nhận diện)
      if (p.startsWith("/watch") || p.startsWith("/playlist")) return "music";
    }
  } catch (_) {}
  return null;
}

async function focusInfo() {
  const wins = await chrome.windows.getAll({ populate: true });
  const foc = wins.filter((w) => w.focused).flatMap((w) => (w.tabs || []).filter((t) => t.active));
  const aud = await chrome.tabs.query({ audible: true });
  const all = [...aud, ...foc];
  const pick = (kinds, list) => list.find((t) => kinds.includes(classify(t.url || "")));
  const m = pick(["music", "video"], all);
  return {
    title: m ? m.title || "" : "",
    discord: foc.some((t) => DISCORD_RE.test(t.url || "")), audible: aud.length > 0,
    kind: m ? classify(m.url) : null, url: m ? m.url : "", tabId: m ? m.id : null,
  };
}


const SITE_NAMES = {
  "youtube.com": "YouTube", "facebook.com": "Facebook", "instagram.com": "Instagram", "x.com": "X", "twitter.com": "X",
  "reddit.com": "Reddit", "wikipedia.org": "Wikipedia", "google.com": "Google", "translate.google.com": "Google Dịch",
  "maps.google.com": "Google Maps", "bing.com": "Bing", "medium.com": "Medium", "pinterest.com": "Pinterest",
  "linkedin.com": "LinkedIn", "threads.net": "Threads", "shopee.vn": "Shopee", "lazada.vn": "Lazada", "tiki.vn": "Tiki",
  "amazon.com": "Amazon", "ebay.com": "eBay", "vnexpress.net": "VnExpress", "tuoitre.vn": "Tuổi Trẻ",
  "dantri.com.vn": "Dân Trí", "thanhnien.vn": "Thanh Niên", "kenh14.vn": "Kênh14", "mangadex.org": "MangaDex",
  "webtoons.com": "WEBTOON", "wattpad.com": "Wattpad", "huggingface.co": "Hugging Face", "wikihow.com": "wikiHow",
};
const SITE_KEYS = Object.keys(SITE_NAMES).sort((a, b) => b.length - a.length);

function siteName(host) {
  const k = SITE_KEYS.find((d) => host === d || host.endsWith("." + d));
  if (k) return SITE_NAMES[k];
  const p = host.split(".");
  const base = p.length >= 3 && ["com", "co", "org", "net", "gov", "edu"].includes(p[p.length - 2]) ? p[p.length - 3] : p[p.length - 2] || p[0];
  return base.charAt(0).toUpperCase() + base.slice(1);
}

function cleanTitle(title, site) {
  let t = String(title || "").replace(/^\(\d+\)\s*/, "").trim();
  const e = site.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  t = t.replace(new RegExp("\\s*[-|–—·:]\\s*" + e + "\\s*$", "i"), "").replace(new RegExp("^" + e + "\\s*[-|–—·:]\\s*", "i"), "").trim();
  return t.slice(0, 128);
}


function ytId(u) {
  try {
    const x = new URL(u), h = x.hostname.replace(/^(www|m)\./, "");
    if (h === "youtube.com") {
      if (x.pathname === "/watch") return x.searchParams.get("v");
      const m = x.pathname.match(/^\/live\/([\w-]{6,})/);
      return m ? m[1] : null;
    }
    if (h === "youtu.be") return x.pathname.slice(1) || null;
  } catch (_) {}
  return null;
}

async function ytPlayback(tabId, kind) {
  if (!tabId) return null;
  try {
    const [r] = await chrome.scripting.executeScript({ target: { tabId }, world: "MAIN", func: () => {
      const ms = navigator.mediaSession, md = ms && ms.metadata, el = document.querySelector("video, audio");
      const art = md && md.artwork && md.artwork.length ? md.artwork[md.artwork.length - 1].src : null;
      return { title: md ? md.title : "", artist: md ? md.artist : "", art, t: el ? el.currentTime : null, d: el ? el.duration : null, p: el ? el.paused : !!ms && ms.playbackState === "paused" };
    } });
    const v = r && r.result;
    if (!v) return null;
    const out = { title: v.title || "", artist: v.artist || "", art: /^https:/.test(v.art || "") ? v.art : null, paused: !!v.p, start: null, end: null };
    if (v.t !== null) { out.start = Date.now() - v.t * 1000; if (kind === "music" && isFinite(v.d) && v.d > 0) out.end = out.start + v.d * 1000; }
    return out;
  } catch (_) { return null; }
}

const ytCache = new Map();
async function ytInfo(id) {
  if (ytCache.has(id)) return ytCache.get(id);
  try {
    const r = await fetch(`https://www.youtube.com/oembed?format=json&url=${encodeURIComponent("https://www.youtube.com/watch?v=" + id)}`);
    if (!r.ok) throw new Error(r.status);
    const j = await r.json();
    const info = { title: j.title || "", author: j.author_name || "" };
    ytCache.set(id, info);
    return info;
  } catch (_) { return null; }
}

async function computeMode() {
  const { rules } = await chrome.storage.local.get(["rules"]);
  const r = { ...DEF_RULES, ...(rules || {}) };
  const f = await focusInfo();
  if (f.kind && ((f.kind === "music" && r.music) || (f.kind === "video" && r.video))) {
    let pb = r.media !== false ? await ytPlayback(f.tabId, f.kind) : null;
    const id = ytId(f.url);
    if (r.media !== false && id && !(pb && pb.title)) {
      const i = await ytInfo(id);
      if (i) pb = { start: pb ? pb.start : null, end: pb ? pb.end : null, paused: pb ? pb.paused : false, title: i.title, artist: i.author, art: `https://i.ytimg.com/vi/${id}/hqdefault.jpg` };
    }
    if (r.media !== false && !(pb && pb.title) && f.title) {
      const hn = new URL(f.url).hostname.replace(/^(www|m)\./, ""), sn = siteName(hn);
      pb = { start: pb ? pb.start : null, end: pb ? pb.end : null, paused: pb ? pb.paused : false, art: pb ? pb.art : null, title: cleanTitle(f.title, sn) || f.title, artist: sn };
    }
    return { mode: f.kind, key: pb && pb.title ? `${pb.title}|${pb.artist}` : "", pb };
  }
  return { mode: "none", key: "" };
}

async function refreshMode() {
  const { mode, key, pb } = await computeMode();
  const has = pb && pb.title;
  await chrome.storage.local.set({ mode, mediaKey: key, mediaInfo: has ? { title: pb.title, artist: pb.artist, art: pb.art } : null, mediaStart: pb ? pb.start : null, mediaEnd: pb ? pb.end : null, mediaPaused: !!(pb && pb.paused) });
  return { mode, key, pb };
}

async function syncNow() {
  const old = await chrome.storage.local.get(["enabled", "mode", "mediaKey", "mediaStart", "mediaPaused"]);
  if (!old.enabled) return;
  const n = await refreshMode();
  const paused = !!(n.pb && n.pb.paused);
  const seek = n.pb && n.pb.start && old.mediaStart && !paused && Math.abs(n.pb.start - old.mediaStart) > 5000;
  if (n.mode !== old.mode || n.key !== (old.mediaKey || "") || paused !== !!old.mediaPaused || seek) startActivity().catch(console.error);
}

let syncTimer;
function scheduleSync() { clearTimeout(syncTimer); syncTimer = setTimeout(syncNow, 2000); }
chrome.tabs.onActivated.addListener(scheduleSync);
chrome.tabs.onRemoved.addListener(scheduleSync);
chrome.tabs.onUpdated.addListener((_id, info) => { if (info.url || info.status === "complete") scheduleSync(); });
chrome.windows.onFocusChanged.addListener(scheduleSync);

async function deleteSession() {
  const { session } = await chrome.storage.local.get("session");
  if (!session) return;
  await chrome.storage.local.set({ session: null });
  try {
    await fetch(`${API}/users/@me/headless-sessions/delete`, {
      method: "POST",
      headers: { Authorization: `Bearer ${await getAccessToken()}`, "Content-Type": "application/json" },
      body: JSON.stringify({ token: session }),
    });
  } catch (_) {}
}

async function badge() {
  const { enabled } = await chrome.storage.local.get("enabled");
  chrome.action.setBadgeText({ text: enabled ? "ON" : "" });
  chrome.action.setBadgeBackgroundColor({ color: "#23a55a" });
}
badge();

chrome.commands.onCommand.addListener(async (c) => {
  if (c !== "toggle") return;
  const { enabled } = await chrome.storage.local.get("enabled");
  if (enabled) await stopActivity();
  else { await refreshMode(); await startActivity().catch(console.error); }
  badge();
});
