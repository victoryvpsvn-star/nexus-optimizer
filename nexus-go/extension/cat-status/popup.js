const st = document.getElementById("st");
const sk = document.getElementById("sk");
const err = document.getElementById("err");

const send = (t) => new Promise((res) => chrome.runtime.sendMessage({ type: t }, (r) => res(r || {})));

async function refresh() {
  const { user, enabled, lastError, sakura } = await chrome.storage.local.get(["user", "enabled", "lastError", "sakura"]);
  st.textContent = enabled ? (user ? `BẬT (${user})` : "BẬT — chưa đăng nhập") : "tắt";
  sk.textContent = sakura ? "ĐANG MỞ ✅ (beacon)" : "không thấy (tool đóng?)";
  err.textContent = lastError || (enabled && !user ? "Bấm Đăng nhập Discord trước." : "");
}

document.getElementById("login").onclick = async () => { await send("login"); setTimeout(refresh, 1500); };
document.getElementById("on").onclick = async () => { const r = await send("start"); err.textContent = r && r.error ? r.error : ""; refresh(); };
document.getElementById("off").onclick = async () => { await send("stop"); refresh(); };

refresh();
setInterval(refresh, 3000);
