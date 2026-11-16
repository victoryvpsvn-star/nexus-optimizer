const $ = (id) => document.getElementById(id);
const F = ["type","name","details","state","timer","image","imageText","smallImage","smallText","b1l","b1u","b2l","b2u"];
const B = {type:"0",timer:"auto",image:"preview",smallImage:"",smallText:"",b1l:"",b1u:"",b2l:"",b2u:""};
const BASEM = {...B,imageText:""};
const VIDEO = {...BASEM,name:"Video",details:"đang xem 📺",state:"",imageText:"đang xem"};
const MUSIC = {...BASEM,name:"Nhạc",details:"đang nghe nhạc 🎧",state:"",imageText:"đang nghe nhạc"};
const BUILTIN = {"Mặc định: nghe nhạc 🎧": MUSIC, "Mặc định: xem video 📺": VIDEO, "Chỉ ghi 'Đang nghe nhạc'": {...MUSIC,details:"Đang nghe nhạc",state:"🎧"}};
const DEFD = {video: VIDEO, music: MUSIC};
let presets = {...BUILTIN}, draft = {...DEFD}, editing = "music";
const rulesRead = () => ({video:$("rVideo").checked, music:$("rMusic").checked, media:$("rMedia").checked});
const rulesFill = (r={}) => { $("rVideo").checked = r.video ?? true; $("rMusic").checked = r.music ?? true; $("rMedia").checked = r.media ?? true; };
const say = (t) => ($("msg").textContent = t);
const send = (m) => new Promise((r) => chrome.runtime.sendMessage(m, r));
const read = () => ({...Object.fromEntries(F.map((k) => [k, $(k).value.trim()])), hide: $("hide").checked});
const fill = (c) => { F.forEach((k) => ($(k).value = c[k] ?? B[k] ?? "")); $("hide").checked = !!c.hide; };
const custom = () => Object.fromEntries(Object.entries(presets).filter(([k]) => !(k in BUILTIN)));
function renderPresets(sel) {
  $("preset").innerHTML = Object.keys(presets).map((n) => `<option>${n.replace(/</g,"&lt;")}</option>`).join("");
  if (sel) $("preset").value = sel;
}
$("redir").textContent = `https://${chrome.runtime.id}.chromiumapp.org/`;
chrome.storage.local.get(["cfgs","auto","rules","user","enabled","loginError","presets"]).then((d) => {
  presets = {...BUILTIN, ...(d.presets||{})}; renderPresets();
  draft = {...DEFD, ...(d.cfgs||{})}; rulesFill(d.rules); fill(draft.music);
  if (d.user) $("who").textContent = "Đã đăng nhập: " + d.user;
  say(d.loginError || (d.enabled ? "Đang bật ✅" : ""));
});
$("editing").onchange = () => { draft[editing] = read(); editing = $("editing").value; fill(draft[editing]); };
$("preset").onchange = () => fill(presets[$("preset").value]);
$("savePreset").onclick = async () => {
  const n = $("presetName").value.trim() || $("preset").value;
  presets[n] = read(); await chrome.storage.local.set({presets: custom()}); renderPresets(n); say("Đã lưu mẫu: " + n);
};
$("delPreset").onclick = async () => {
  const n = $("preset").value;
  if (n in BUILTIN) return say("Mẫu có sẵn không xóa được");
  delete presets[n]; await chrome.storage.local.set({presets: custom()}); renderPresets(); say("Đã xóa " + n);
};
$("login").onclick = async () => {
  const r = await send({type:"login"});
  say(r.ok ? "Đã mở tab Discord: bấm Authorize, rồi mở lại popup." : r.error);
};
$("start").onclick = async () => {
  draft[editing] = read(); say("Đang bật...");
  const r = await send({type:"start", cfgs: draft, auto: true, rules: rulesRead()});
  say(r.ok ? "Đang bật ✅ (tự đổi theo tab)" : r.error);
};
$("stop").onclick = async () => { const r = await send({type:"stop"}); say(r.ok ? "Đã tắt" : r.error); };

$("resetAll").onclick = () => { draft = {...DEFD}; fill(draft[editing]); say("Đã khôi phục mặc định (bấm Bật status để áp dụng)"); };
