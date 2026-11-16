// Popup v2.5.0 — 3 bước rõ ràng + popup TỰ kiểm tra beacon (không chờ alarm 30s)
const st = document.getElementById("st");
const se = document.getElementById("se");
const sk = document.getElementById("sk");
const err = document.getElementById("err");
const BEACON_PORTS = [32123, 32124];

document.getElementById("ver").textContent = "extension v" + chrome.runtime.getManifest().version + " — nếu Discord vẫn không hiện: F5 Discord hoặc kiểm tra setting Discord «Hiển thị hoạt động».";

const send = (t) => new Promise((res) => chrome.runtime.sendMessage({ type: t }, (r) => res(r || {})));

async function beaconCheck() {
  for (const p of BEACON_PORTS) {
    try {
      const r = await fetch(`http://127.0.0.1:${p}/api/presence-beacon`, { signal: AbortSignal.timeout(1500) });
      if (r.ok) {
        const j = await r.json();
        if (j && j.app === "sakura-tool") return `✅ đang mở (beacon 127.0.0.1:${p})`;
      }
    } catch (_) {}
  }
  return null;
}

function mark(id, ok) {
  const el = document.getElementById(id);
  el.classList.toggle("ok", ok);
  el.classList.toggle("bad", !ok);
}

async function refresh() {
  const { user, enabled, lastError, sakura } = await chrome.storage.local.get(["user", "enabled", "lastError", "sakura"]);
  st.textContent = user ? `✅ ${user}` : "❌ bấm Đăng nhập";
  se.textContent = enabled ? "✅ đã Bật" : "❌ bấm Bật (tự mở login nếu cần)";
  mark("s1", !!user); mark("s2", !!enabled);
  err.textContent = lastError || "";
  const b = await beaconCheck();
  sk.textContent = b || "❌ không thấy — mở Sakura Tool lên";
  mark("s3", !!b);
}

document.getElementById("login").onclick = async () => { await send("login"); setTimeout(refresh, 1500); };
document.getElementById("on").onclick = async () => {
  const r = await send("start");
  err.textContent = r && r.error ? r.error : "";
  refresh();
  setTimeout(refresh, 2500);
};
document.getElementById("off").onclick = async () => { await send("stop"); refresh(); };

refresh();
setInterval(refresh, 3000);
