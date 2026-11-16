// Cat Status v2.3.0 — CHỈ báo Discord khi Sakura Tool đang mở.
// BỎ hoàn toàn dect nhạc/video (tabs classify, mediaSession, oembed...).
// Báo qua API Discord trực tiếp (headless-sessions, OAuth đã đăng nhập) →
// KHÔNG CẦN Discord desktop. Dect "tool đang mở" = poll beacon localhost của tool;
// tool đóng → xóa presence, giữ enabled để tự báo lại khi mở lại (kiểu PreMiD).
const CLIENT_ID = "1563917712227442731";
const API = "https://discord.com/api/v10";
const SCOPES = "openid sdk.social_layer_presence";
const BEACON_PORTS = [32123, 32124];

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
    if (q.get("state") !== pending.state || !q.get("code")) throw new Error("Đăng nhập bị hủy hoặc lỗi: " + (q.get("error_description") || q.get("error") || ""));
    const auth = await tokenRequest({
      grant_type: "authorization_code", code: q.get("code"),
      redirect_uri: REDIRECT, code_verifier: pending.verifier,
    });
    let name = "OK";
    try {
      const me = await (await fetch(`${API}/oauth2/userinfo`, { headers: { Authorization: `Bearer ${auth.access_token}` } })).json();
      name = me.global_name || me.preferred_username || me.username || "OK";
    } catch (_) {}
    await chrome.storage.local.set({ user: name, loginError: null, lastError: null });
    const { enabled } = await chrome.storage.local.get("enabled");
    if (enabled) { lastKey = ""; syncSakura().catch(() => {}); }
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

async function postActivity(activity) {
  const { session } = await chrome.storage.local.get("session");
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
    if (body.includes("50014")) throw new Error("Phiên đăng nhập Discord hết hạn hoặc bị thu hồi. Bấm Đăng nhập lại rồi Bật.");
    throw new Error(`Discord báo lỗi ${res.status}: ${body}`);
  }
  const j = await res.json();
  await chrome.storage.local.set({ session: j.token, lastError: null });
  badge();
  return j;
}

async function deleteSession() {
  const { session } = await chrome.storage.local.get("session");
  await chrome.storage.local.set({ session: null });
  if (!session) return;
  try {
    await fetch(`${API}/users/@me/headless-sessions/delete`, {
      method: "POST",
      headers: { Authorization: `Bearer ${await getAccessToken()}`, "Content-Type": "application/json" },
      body: JSON.stringify({ token: session }),
    });
  } catch (_) {}
}

// ---------- dect Sakura Tool qua beacon (đã bỏ dect nhạc) ----------

let lastKey = "";

async function sakuraInfo() {
  for (const p of BEACON_PORTS) {
    try {
      const r = await fetch(`http://127.0.0.1:${p}/api/presence-beacon`, { signal: AbortSignal.timeout(2500) });
      if (!r.ok) continue;
      const j = await r.json();
      if (j && j.app === "sakura-tool") {
        return { via: "beacon", section: j.section || "", note: j.note || "", started: j.started || Math.floor(Date.now() / 1000) };
      }
    } catch (_) {}
  }
  // Fallback: cổng beacon bị app khác chiếm → quét tab localhost có tiêu đề Sakura
  try {
    const tabs = await chrome.tabs.query({ url: ["http://127.0.0.1/*", "http://localhost/*"] });
    if ((tabs || []).some((t) => /sakura/i.test(t.title || ""))) {
      return { via: "tab", section: "", note: "🌸 đang mở trong trình duyệt", started: Math.floor(Date.now() / 1000) };
    }
  } catch (_) {}
  return null;
}

async function syncSakura() {
  const { enabled } = await chrome.storage.local.get("enabled");
  if (!enabled) return;
  let info = null;
  try { info = await sakuraInfo(); } catch (_) {}
  if (!info) {
    // Tool đóng → xóa presence nhưng GIỮ enabled: mở lại tool là tự báo (kiểu PreMiD)
    if (lastKey) { await deleteSession().catch(() => {}); lastKey = ""; }
    await chrome.storage.local.set({ sakura: false });
    badge();
    return;
  }
  await chrome.storage.local.set({ sakura: true, lastError: null });
  const mins = Math.max(0, Math.floor(Date.now() / 1000) - info.started) / 60 | 0;
  const details = ("🌸 Đang tweak máy" + (info.section ? " — " + info.section : "")).slice(0, 128);
  const state = (info.note || `⏱ đã dùng ${mins} phút`).slice(0, 128);
  const key = `${details}|${state}|${info.started}`;
  if (key === lastKey) return; // không đổi → không spam API Discord
  lastKey = key;
  try {
    await postActivity({
      application_id: CLIENT_ID,
      name: "Sakura Tool",
      type: 0,
      platform: "desktop",
      details,
      state,
      timestamps: { start: info.started },
    });
  } catch (e) {
    lastKey = "";
    await chrome.storage.local.set({ lastError: String(e.message || e) });
  }
}

function ensureAlarms() { chrome.alarms.create("beacon", { periodInMinutes: 0.5 }); }

chrome.alarms.onAlarm.addListener(async (a) => {
  if (a.name === "beacon") syncSakura().catch(() => {});
});

chrome.runtime.onStartup.addListener(async () => {
  const { enabled } = await chrome.storage.local.get("enabled");
  if (enabled) { lastKey = ""; syncSakura().catch(() => {}); ensureAlarms(); }
});

chrome.runtime.onInstalled.addListener(async () => {
  const { enabled } = await chrome.storage.local.get("enabled");
  if (enabled) { lastKey = ""; syncSakura().catch(() => {}); ensureAlarms(); }
});

chrome.runtime.onMessage.addListener((msg, _s, send) => {
  (async () => {
    try {
      if (msg.type === "login") await login();
      else if (msg.type === "start") {
        await chrome.storage.local.set({ enabled: true, startedAt: Date.now(), lastError: null });
        lastKey = "";
        await syncSakura();
        ensureAlarms();
      } else if (msg.type === "stop") {
        await chrome.alarms.clear("beacon");
        lastKey = "";
        await deleteSession().catch(() => {});
        await chrome.storage.local.set({ enabled: false, session: null });
      }
      send({ ok: true });
    } catch (e) { send({ ok: false, error: String(e.message || e) }); }
  })();
  return true;
});

function badge() {
  chrome.storage.local.get("enabled").then(({ enabled }) => {
    chrome.action.setBadgeText({ text: enabled ? "ON" : "" });
    chrome.action.setBadgeBackgroundColor({ color: "#23a55a" });
  });
}
badge();

chrome.commands.onCommand.addListener(async (c) => {
  if (c !== "toggle") return;
  const { enabled } = await chrome.storage.local.get("enabled");
  if (enabled) {
    await chrome.alarms.clear("beacon");
    lastKey = "";
    await deleteSession().catch(() => {});
    await chrome.storage.local.set({ enabled: false, session: null });
  } else {
    await chrome.storage.local.set({ enabled: true, startedAt: Date.now(), lastError: null });
    lastKey = "";
    await syncSakura().catch(() => {});
    ensureAlarms();
  }
  badge();
});
