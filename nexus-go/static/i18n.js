/* Sakura Tool — i18n.js
 * Chuyển đổi ngôn ngữ TIẾNG VIỆT ↔ ENGLISH cho toàn bộ UI chrome (vanilla, tự chứa, không deps).
 *
 * Cơ chế:
 * - window.I18N: dictionary VI→EN (exact-match sau trim qua Map/Object; không có trong dict → giữ nguyên).
 * - lang=vi hiển thị chuỗi GỐC: original của mỗi text node/attribute được lưu vào WeakMap trước khi
 *   dịch lần đầu; chuyển về vi thì khôi phục đúng chuỗi gốc.
 * - MutationObserver chỉ xử lý node THÊM MỚI (addedNodes), textContent thay đổi (characterData) và
 *   attribute placeholder/title; batch xử lý trong 1 requestAnimationFrame.
 * - Pass toàn trang đúng 1 lần lúc init (khi lang=en) — observer lo phần render sau đó.
 * - Bỏ qua node trong SCRIPT/STYLE/TEXTAREA/INPUT/PRE/CODE/NOSCRIPT; không dịch text node >500 ký tự
 *   (mô tả tweak dài) trừ khi chuỗi đó có exact-match trong dict.
 * - Chuỗi động (toast/setBusy/đếm/chip nhóm...) dịch bằng translateDynamic() theo regex pattern.
 * - Nút 🌐 EN/VI inject vào .topbar; lưu localStorage 'sakura-lang' ('vi' mặc định) và persist lên
 *   server: GET /api/settings → merge {…s, lang} → PUT /api/settings (toàn bộ trong try/catch).
 * Lưu ý: mô tả/tên 1000 tinh chỉnh (data từ server) cố ý GIỮ tiếng Việt theo yêu cầu.
 */
(function () {
  'use strict';

  if (window.__SAKURA_I18N_LOADED__) return;
  window.__SAKURA_I18N_LOADED__ = true;

  /* ================== Dictionary VI → EN ================== */
  window.I18N = {
    /* ---- 28 nhóm tinh chỉnh thật (cột category trong data/*.tsv) + nhãn "Tất cả" ---- */
    'Dịch vụ': 'Services',
    'Telemetry & Riêng tư': 'Telemetry & Privacy',
    'Edge & Trình duyệt': 'Browsers',
    'Task định kỳ': 'Scheduled Tasks',
    'Bloatware (UWP)': 'Bloatware (UWP)',
    'Defender & Bảo mật': 'Defender & Security',
    'Giao diện & Taskbar': 'UI & Taskbar',
    'Mạng': 'Network',
    'Hiệu năng': 'Performance',
    'Hạ tầng': 'Infrastructure',
    'Explorer & File': 'Explorer & Files',
    'Nguồn & Điện': 'Power',
    'Cập nhật Windows': 'Windows Update',
    'Ổ đĩa & File system': 'Disk & File system',
    'Remote & Chia sẻ': 'Remote & Sharing',
    'Chuột': 'Mouse',
    'OneDrive & Cloud': 'OneDrive & Cloud',
    'In ấn & Thiết bị': 'Printing & Devices',
    'Bàn phím': 'Keyboard',
    'Kernel & Hệ thống': 'Kernel & System',
    'GPU': 'GPU',
    'Wi-Fi & Bluetooth': 'Wi-Fi & Bluetooth',
    'RAM': 'RAM',
    'Boot & Khởi động': 'Boot',
    'Âm thanh': 'Audio',
    'Màn hình': 'Display',
    'CPU': 'CPU',
    'Gaming': 'Gaming',
    'Gaming & Xbox': 'Gaming & Xbox',
    'Tất cả': 'All',

    /* ---- Điều hướng (nav) ---- */
    'Tổng quan': 'Overview',
    'Dọn dẹp': 'Cleanup',
    'Tinh chỉnh': 'Tweaks',
    'Tiến trình': 'Processes',
    'Script nâng cao': 'Advanced Script',
    'Tự kiểm tra': 'Self-test',
    'Ảnh chụp': 'Screenshots',
    'Sao lưu': 'Backup',
    'Cài đặt': 'Settings',

    /* ---- Tiêu đề + phụ đề section (SECTION_META) ---- */
    'Giám sát CPU, RAM, Disk realtime': 'Realtime CPU, RAM & disk monitoring',
    'Giải phóng RAM + Disk chỉ với một cú nhấp': 'Free up RAM + disk in one click',
    'Tăng hiệu năng tối đa khi chơi game': 'Maximum performance while gaming',
    'Danh sách tối ưu xếp hạng theo độ ưu tiên': 'Optimizations ranked by priority',
    'Quản lý tiến trình đang chạy': 'Manage running processes',
    'Giao diện + cổng đang lắng nghe': 'Interfaces + listening ports',
    'Tự viết và chạy script tùy chỉnh — Advanced': 'Write & run your own scripts — Advanced',
    'Kiểm tra sức khỏe hệ thống + toàn bộ tinh chỉnh, báo cáo về Discord': 'System health check + every tweak, report sent to Discord',
    'Chụp & lưu ảnh màn hình dashboard': 'Capture & save dashboard screenshots',
    'Backup registry các key tinh chỉnh (file .reg)': 'Back up registry keys used by tweaks (.reg files)',
    'Tùy chỉnh màu nhấn, bo góc, hiệu ứng': 'Accent color, corner radius, effects',

    /* ---- Topbar / badge ---- */
    '🌸 100% FREE — không Plus, không khóa tính năng': '🌸 100% FREE — no Plus, no locked features',
    '👤 thường': '👤 Standard',
    'reg.exe thiếu': 'reg.exe missing',
    'PowerShell thiếu': 'PowerShell missing',
    'thiếu': 'missing',

    /* ---- Overview ---- */
    'Bộ tối ưu PC của bạn — mọi tính năng đều': 'Your PC optimizer — every feature is',
    'MIỄN PHÍ 100%': '100% FREE',
    ', không Plus, không quảng cáo, không khóa gì cả.': ', no Plus, no ads, nothing locked.',
    'Ổ đĩa': 'Disk',
    'Đã giải phóng': 'Freed so far',
    'tổng dung lượng tool đã dọn giúp bạn': 'total space this tool has cleaned for you',
    'CPU 60 giây qua': 'CPU — last 60 seconds',
    'Ổ đĩa chi tiết': 'Disk details',
    'Hệ thống': 'System',
    'Ổ': 'Drive',
    'Tổng': 'Total',
    'Đã dùng': 'Used',
    'Còn lại': 'Free',
    'Không đọc được ổ đĩa': 'Cannot read disks',
    'Nền tảng': 'Platform',
    'Số tiến trình': 'Processes',
    'Chưa dọn lần nào — vào tab Dọn dẹp 🌸': 'Never cleaned yet — visit the Cleanup tab 🌸',
    'Quyền Admin': 'Admin rights',
    '✅ có': '✅ yes',
    '❌ không': '❌ no',

    /* ---- Cleanup ---- */
    '🧹 Dọn dẹp thông minh': '🧹 Smart Cleanup',
    'Tick chọn mục bạn muốn dọn — chỉ dọn': 'Tick the items you want to clean — cleans only',
    'ĐÚNG': 'EXACTLY',
    'những gì bạn chọn, xem dung lượng từng mục trước khi dọn.': 'what you picked, with per-item sizes shown before cleaning.',
    '✅ Chọn tất cả': '✅ Select all',
    '⬜ Bỏ chọn hết': '⬜ Deselect all',
    '🧹 Dọn các mục đã chọn': '🧹 Clean selected items',
    '⚡ Dọn RAM ngay': '⚡ Free RAM now',
    'Chọn tất cả': 'Select all',
    'Mục tiêu dọn dẹp — chọn mục muốn dọn': 'Cleanup targets — pick what to clean',
    'Lịch sử dọn dẹp': 'Cleanup history',
    'Kết quả lần chạy gần nhất': 'Last run results',
    'Thời gian': 'Time',
    'Loại': 'Type',
    'Mục tiêu': 'Target',
    'Giải phóng': 'Freed',
    'cần Admin': 'Admin required',
    '⚠️ cần Admin': '⚠️ Admin required',
    '🔑 cần Admin': '🔑 Admin required',
    'Không có mục tiêu nào': 'No targets found',
    'Chưa có log nào': 'No logs yet',
    'Hãy tick chọn ít nhất một mục muốn dọn 🌸': 'Tick at least one item to clean 🌸',
    'Đang chạy…': 'Running…',

    /* ---- Gaming ---- */
    'Bật Gaming Mode': 'Enable Gaming Mode',
    '🎮 Bật Gaming Mode': '🎮 Enable Gaming Mode',
    '↩️ Tắt Gaming Mode': '↩️ Disable Gaming Mode',
    'Đang tắt': 'Off',
    'Kết quả áp dụng': 'Apply results',
    'Chi tiết': 'Details',
    'Chưa chạy lần nào': 'Never run yet',
    'Đã bật Gaming Mode': 'Gaming Mode enabled',
    'Đã tắt Gaming Mode': 'Gaming Mode disabled',

    /* ---- Tweaks ---- */
    '✅ Áp dụng mục đã chọn': '✅ Apply selected',
    '↩️ Hoàn tác mục đã chọn': '↩️ Revert selected',
    'Bỏ chọn': 'Deselect',
    'Đang tải nhóm…': 'Loading categories…',
    'Không có tinh chỉnh nào trong nhóm này.': 'No tweaks in this category.',
    'Áp dụng': 'Apply',
    'Hoàn tác': 'Revert',
    'khuyến nghị': 'Recommended',
    'đã áp dụng': 'Applied',
    'Chưa chọn mục nào': 'No items selected',

    /* ---- Processes ---- */
    '🔄 Làm mới': '🔄 Refresh',
    'Tên': 'Name',
    'Người dùng': 'User',
    'Không có tiến trình khớp': 'No matching processes',
    'Xong': 'Done',

    /* ---- Network ---- */
    'Giao diện mạng': 'Network interfaces',
    'Cổng đang LISTEN': 'Listening ports',
    'Không có giao diện nào': 'No interfaces found',
    'Không đọc được cổng LISTEN': 'Cannot read listening ports',

    /* ---- Script ---- */
    'Chạy script tùy chỉnh (Advanced)': 'Run a custom script (Advanced)',
    "Chỉ dành cho người biết code — script chạy với quyền của app. Timeout tối đa 180s.": "For people who code — scripts run with the app's privileges. Max timeout 180s.",
    '▶️ Chạy': '▶️ Run',
    'Script đã lưu': 'Saved scripts',
    'Chưa lưu script nào': 'No saved scripts yet',
    'Đã xóa script': 'Script deleted',
    '(không có output)': '(no output)',

    /* ---- Self-test ---- */
    'Kiểm tra môi trường + toàn bộ catalog tinh chỉnh.': 'Check the environment + the entire tweak catalog.',
    '🧪 Kiểm tra (check)': '🧪 Check',
    'Lưu webhook': 'Save webhook',
    'Báo cáo': 'Report',
    '✅ có quyền': '✅ admin granted',
    '❌ không có quyền Admin': '❌ no admin rights',
    '✅ sẵn sàng': '✅ ready',
    '❌ thiếu': '❌ missing',
    'Catalog': 'Catalog',
    'Chưa cấu hình webhook Discord': 'Discord webhook not configured',
    'Đã lưu webhook Discord': 'Discord webhook saved',
    'KẾT QUẢ ĐẠT': 'ALL PASSED',
    'CÓ LỖI': 'HAS FAILURES',

    /* ---- Screenshot ---- */
    'Ảnh chụp màn hình': 'Screenshots',
    'Chụp dashboard (Ctrl+Shift+S hoặc nút bên dưới) → lưu vào thư mục dữ liệu.': 'Capture the dashboard (Ctrl+Shift+S or the button below) → saved into the data folder.',
    '📷 Chụp dashboard': '📷 Capture dashboard',
    'Chưa có ảnh chụp nào': 'No screenshots yet',
    'Đã lưu ảnh chụp': 'Screenshot saved',
    'Xóa': 'Delete',
    'Không render được ảnh (ảnh ngoài/CORS)': 'Cannot render image (external image/CORS)',

    /* ---- Backup ---- */
    'Sao lưu registry': 'Registry backup',
    'Export các key registry mà tinh chỉnh đụng tới thành file .reg — chạy TRƯỚC khi áp dụng tinh chỉnh để có thể khôi phục bằng cách import.': 'Export the registry keys touched by tweaks into a .reg file — run it BEFORE applying tweaks so you can restore by importing.',
    '💾 Tạo backup registry': '💾 Create registry backup',
    '📂 Mở thư mục backup': '📂 Open backup folder',
    'Kích thước': 'Size',
    'Chưa có backup nào': 'No backups yet',
    'Đã tạo backup': 'Backup created',

    /* ---- Settings ---- */
    'Giao diện': 'Appearance',
    'Màu nhấn': 'Accent color',
    'Bo góc (rem)': 'Corner radius (rem)',
    'Hiệu ứng cánh hoa': 'Petal effect',
    'Lưu cài đặt': 'Save settings',
    'Đã lưu cài đặt': 'Settings saved',
    'Phiên bản': 'Version',
    '— Go edition, 1 exe duy nhất, không cần cài đặt.': '— Go edition, a single exe, no installation needed.',
    '🛡️ Chạy lại với quyền Admin': '🛡️ Relaunch as Admin',
    'Đã yêu cầu nâng quyền': 'Elevation requested',

    /* ---- Welcome overlay ---- */
    '🌸 Chào mừng đến với Sakura Tool': '🌸 Welcome to Sakura Tool',
    'Khuyến cáo:': 'Warning:',
    'Tool tweak vẫn có thể gây lỗi — vui lòng tạo điểm khôi phục / backup trước khi áp dụng bất kỳ tinh chỉnh nào.': 'Tweaking can still cause issues — please create a restore point / backup before applying any tweak.',
    'ℹ️ Tool không tối ưu 100% — nếu không thấy tăng hiệu năng, đó có thể là giới hạn phần cứng của máy bạn (ổ đĩa, RAM, CPU cũ...)': 'ℹ️ No optimizer is magic — if you see no performance gain, it may be your hardware limit (old disk, RAM, CPU...)',
    '📜 Danh sách luật': '📜 The rules',
    '1. Luôn tạo điểm khôi phục trước lần áp dụng đầu tiên (nút bên dưới).': '1. Always create a restore point before your first apply (button below).',
    "2. Đọc mô tả + mức rủi ro từng tweak, không bấm đại.": "2. Read each tweak's description + risk level — never click blindly.",
    '3. Không áp dụng hàng loạt mục HIGH RISK cùng lúc.': '3. Never apply many HIGH RISK items at once.',
    '4. Sau khi áp dụng nên khởi động lại máy để chắc chắn hiệu lực.': '4. Reboot after applying to make sure it takes effect.',
    '5. Gặp lỗi → bấm Hoàn tác ngay hoặc dùng điểm khôi phục Windows.': '5. On error → hit Revert immediately or use a Windows restore point.',
    "6. Tool không thay thế antivirus — các nút Defender là để BẬT bảo vệ, không phải tắt.": "6. This tool doesn't replace antivirus — the Defender buttons turn protection ON, never off.",
    '7. Chỉ dùng trên máy cá nhân; không dùng trên máy công ty/domain.': '7. Personal PCs only — never on company/domain machines.',
    '8. Cấu hình yếu là giới hạn phần cứng — tool không làm phép màu, chỉ giải phóng nền.': '8. Weak specs are a hardware limit — no magic here, just less background load.',
    'Tôi đã đọc và đồng ý các luật trên': 'I have read and agree to the rules above',
    '🛡️ Tạo điểm khôi phục ngay': '🛡️ Create restore point now',
    '🌸 Bắt đầu': '🌸 Get started',
    'Đang tạo điểm khôi phục (có thể mất ~1 phút)…': 'Creating restore point (may take ~1 minute)…',

    /* ---- Update banner ---- */
    '🆕 Có bản mới': '🆕 New version',
    'Cài ngay & tự mở lại': 'Update & relaunch',
    '⬇️ Đang tải bản mới… tool sẽ': '⬇️ Downloading… the tool will',
    'tự đóng và tự mở lại': 'close and relaunch by itself',
    '(tối đa ~1 phút). Nếu 2 phút không thấy mở lại, hãy mở tool tay.': '(up to ~1 minute). If it hasn\'t reopened after 2 minutes, reopen it manually.',

    /* ---- Chuỗi UI ngắn do server trả về (note + lỗi → hiện trong UI) ---- */
    'App đang chạy ngoài Windows — các tinh chỉnh Windows chỉ chạy được trong bản .exe': 'App is running outside Windows — Windows tweaks only work in the .exe build',
    'Dọn RAM chạy EmptyWorkingSet + xả standby list: tiến trình nặng nhả working set ngay; standby list cần quyền Administrator để trả RAM về available.': 'RAM cleanup runs EmptyWorkingSet + a standby-list purge: heavy processes release their working set right away; the standby list needs Administrator rights to give RAM back to available.',
    'Dọn RAM cần bản Windows .exe (dùng EmptyWorkingSet qua PowerShell).': 'RAM cleanup needs the Windows .exe build (EmptyWorkingSet via PowerShell).',
    'Các tinh chỉnh HKCU áp dụng ngay cho user hiện tại; các mục HKLM/service cần quyền Administrator — nếu thiếu quyền sẽ báo lỗi trung thực.': 'HKCU tweaks apply instantly for the current user; HKLM/service items need Administrator — without it they fail honestly with a visible error.',
    'Gaming Mode chỉ áp dụng được trên Windows (bản .exe) — các mục sẽ được báo lỗi trung thực.': 'Gaming Mode only works on Windows (.exe build) — items will report honest errors.',
    'Chưa cấu hình webhook Discord (dán URL webhook trong tab Tự kiểm tra)': 'Discord webhook not configured (paste the webhook URL in the Self-test tab)',
    'An toàn — Windows tự dựng lại': 'Safe — Windows rebuilds it automatically',
    'Chỉ xóa file thumbcache_*.db / iconcache_*.db (Windows tự dựng lại)': 'Only deletes thumbcache_*.db / iconcache_*.db files (Windows rebuilds them)',
    'Cần quyền Administrator — Windows tự tải lại khi Update': 'Needs Administrator — Windows re-downloads it on Update',
    'Cần quyền Administrator — dung lượng giải phóng không đo được chính xác': 'Needs Administrator — freed size cannot be measured exactly',
    'Cần quyền Administrator': 'Needs Administrator',
    'Thư mục TEMP của user hiện tại': 'TEMP folder of the current user',
    'Xóa vĩnh viễn các file đang nằm trong Thùng rác': 'Permanently deletes files sitting in the Recycle Bin',
    'Dữ liệu không hợp lệ': 'Invalid data',
    'Không tìm thấy backup': 'Backup not found',
    'Không tìm thấy script': 'Script not found',
    'Không tìm thấy ảnh': 'Screenshot not found',
    'Không đọc được danh sách tiến trình': 'Cannot read process list',
    'Tối đa 200 tinh chỉnh mỗi lần chạy': 'Max 200 tweaks per run',
    'Yêu cầu không hợp lệ (cần ids[], action)': 'Invalid request (expects ids[], action)',
    'URL webhook không hợp lệ — chỉ chấp nhận https://discord.com/api/webhooks/…': 'Invalid webhook URL — only https://discord.com/api/webhooks/… is accepted',

    /* ---- Chuỗi giữ nguyên (identity, có trong UI nhưng EN = VI) ---- */
    'Gaming Mode': 'Gaming Mode',
    '🎮 Gaming Mode': '🎮 Gaming Mode',
    '🚀 Full (apply → revert)': '🚀 Full (apply → revert)',
    'Chế độ full (apply → revert)': 'Full mode (apply → revert)',
    'Kill': 'Kill',
    'PID': 'PID',
    'CPU %': 'CPU %',
    'RAM %': 'RAM %',
    'RAM (MB)': 'RAM (MB)',
    'File': 'File',
    '%': '%',
    'OK': 'OK',
    '🛡️ Admin': '🛡️ Admin',
    'Hostname': 'Hostname',
    'Uptime': 'Uptime',
    'App exe': 'App exe',
    '100% FREE • Go edition': '100% FREE • Go edition',
    '🌸 Sakura Tool': '🌸 Sakura Tool',
    'Sakura Tool': 'Sakura Tool',
    'Timeout (ms)': 'Timeout (ms)',
    'Webhook': 'Webhook',

    /* ---- Placeholder ---- */
    '🔍 Tìm trong 1000 tinh chỉnh (tên / mô tả / id)…': '🔍 Search 1000 tweaks (name / description / id)…',
    'Tìm tiến trình theo tên / PID…': 'Search processes by name / PID…',
    'Nhập code ở đây…': 'Enter your code here…',
    'https://discord.com/api/webhooks/… (để gửi báo cáo về Discord)': 'https://discord.com/api/webhooks/… (to send reports to Discord)',
    /* ---- v3.4.0: chuỗi card Hình nền (wallpaper.js) ---- */
    '🖼️ Hình nền': '🖼️ Wallpaper',
    'Mặc định': 'Default',
    'Ngẫu nhiên mỗi lần mở': 'Random on each launch',
    'Lớp phủ tối': 'Dim overlay',
    'Thay đổi được áp dụng và lưu tự động — không cần bấm nút.': 'Changes apply instantly and auto-save — no button needed.',
    'dùng khi chọn Custom URL': 'used when Custom URL is selected',
    'URL hình nền không hợp lệ — phải bắt đầu bằng http(s):// hoặc data:image/': 'Invalid background URL — must start with http(s):// or data:image/',
    'https://…/anh.jpg hoặc data:image/…': 'https://…/image.jpg or data:image/…',
  };

  /* ---- Prefix toast/lỗi động: "Tiền tố: chi tiết" → dịch phần trước ": " ---- */
  const PREFIX = {
    'Không quét được mục tiêu dọn dẹp': 'Cannot scan cleanup targets',
    'Dọn dẹp lỗi': 'Cleanup failed',
    'Không đọc được Gaming Mode': 'Cannot read Gaming Mode',
    'Gaming Mode lỗi': 'Gaming Mode failed',
    'Không tải được danh sách tinh chỉnh': 'Cannot load tweak list',
    'Chạy tinh chỉnh lỗi': 'Tweak run failed',
    'Không đọc được tiến trình': 'Cannot read processes',
    'Không đọc được thông tin mạng': 'Cannot read network info',
    'Không tải được script': 'Cannot load scripts',
    'Không đọc được trạng thái self-test': 'Cannot read self-test status',
    'Lưu webhook lỗi': 'Webhook save failed',
    'Self-test lỗi': 'Self-test failed',
    'Chụp ảnh lỗi': 'Screenshot failed',
    'Không đọc được backup': 'Cannot read backups',
    'Backup lỗi': 'Backup failed',
    'Thư mục backup': 'Backup folder',
    'Không đọc được cài đặt': 'Cannot read settings',
    'Lưu cài đặt lỗi': 'Settings save failed',
    'Cài đặt không hợp lệ': 'Invalid settings',
    'Không kết nối được app': 'Cannot connect to app',
    'Dọn gần nhất': 'Last cleanup',
    'Webhook hiện tại': 'Current webhook',
  };

  const DICT = window.I18N;
  const has = (o, k) => Object.prototype.hasOwnProperty.call(o, k);

  /* ================== Pattern động (toast / setBusy / đếm / chip) ================== */
  const PATTERNS = [
    [/^Hiển thị (\d+)\/(\d+)(?: \(lọc "(.+)"\))?(?: · (\d+) đã chọn)?$/,
      (m) => 'Showing ' + m[1] + '/' + m[2] + (m[3] ? ' (filter "' + m[3] + '")' : '') + (m[4] ? ' · ' + m[4] + ' selected' : '')],
    [/^⬇️ Hiện thêm (\d+) mục \(còn (\d+)\)$/,
      (m) => '⬇️ Show ' + m[1] + ' more (' + m[2] + ' left)'],
    [/^Đang (áp dụng|hoàn tác) (\d+)–(\d+)\/(\d+)…$/,
      (m) => (m[1] === 'áp dụng' ? 'Applying ' : 'Reverting ') + m[2] + '–' + m[3] + '/' + m[4] + '…'],
    [/^(Áp dụng|Hoàn tác) xong (\d+) mục(?: — (\d+) lỗi \(xem trong danh sách\))?$/,
      (m) => (m[1] === 'Áp dụng' ? 'Applied ' : 'Reverted ') + m[2] + (m[2] === '1' ? ' item' : ' items') + (m[3] ? ' — ' + m[3] + ' failed (see list)' : '')],
    [/^Đã chọn (\d+) mục — dung lượng có thể giải phóng ~(.+)$/,
      (m) => (m[1] === '1' ? '1 item' : m[1] + ' items') + ' selected — ~' + m[2] + ' reclaimable'],
    [/^Đã chọn (\d+) mục$/,
      (m) => m[1] + (m[1] === '1' ? ' item selected' : ' items selected')],
    [/^(\d+) tinh chỉnh \((\d+) khuyến nghị, (\d+) đã áp dụng\)$/,
      (m) => m[1] + ' tweaks (' + m[2] + ' recommended, ' + m[3] + ' applied)'],
    [/^Đang chạy self-test ([A-Za-z]+)…$/,
      (m) => 'Running ' + m[1] + ' self-test…'],
    [/^Đang bật — từ (.+)$/,
      (m) => 'On — since ' + m[1]],
    [/^rủi ro (low|medium|high)$/,
      (m) => m[1] + ' risk'],
    [/^(\d+) lõi — (.+)$/,
      (m) => m[1] + ' cores — ' + m[2]],
    [/^(.+): còn ([\d.]+) GB \/ ([\d.]+) GB$/,
      (m) => m[1] + ': ' + m[2] + ' GB free / ' + m[3] + ' GB total'],
    [/^(.+) MB \(còn ([\d.]+) MB\)$/,
      (m) => m[1] + ' MB (' + m[2] + ' MB free)'],
    [/^↓ rx \/ ↑ tx KB\/s — tổng ([\d.]+) MB ↓ \/ ([\d.]+) MB ↑$/,
      (m) => '↓ rx / ↑ tx KB/s — total ' + m[1] + ' MB ↓ / ' + m[2] + ' MB ↑'],
    [/^Dọn xong — disk giải phóng (.+), RAM (.+)$/,
      (m) => 'Cleanup done — disk freed ' + m[1] + ', RAM ' + m[2]],
    [/^(.+) — tinh chỉnh Windows chỉ chạy được trong bản \.exe$/,
      (m) => m[1] + ' — Windows tweaks only run in the .exe build'],
    // Chip nhóm tinh chỉnh: "Dịch vụ (109)" / "Tất cả (1075)" — đặt CUỐI để không nuốt pattern khác
    [/^([^\d()]+) \((\d+)\)$/,
      (m) => { const base = m[1].trim(); return has(DICT, base) ? DICT[base] + ' (' + m[2] + ')' : null; }],
  ];

  function translateDynamic(text) {
    for (let i = 0; i < PATTERNS.length; i++) {
      const m = text.match(PATTERNS[i][0]);
      if (m) {
        const out = PATTERNS[i][1](m);
        if (out) return out;
      }
    }
    // "Tiền tố: chi tiết" → dịch tiền tố nếu có trong PREFIX (giữ nguyên chi tiết lỗi từ server)
    const i = text.indexOf(': ');
    if (i > 0 && i <= 80 && has(PREFIX, text.slice(0, i))) {
      return PREFIX[text.slice(0, i)] + ': ' + text.slice(i + 2);
    }
    return null;
  }

  function translateCore(core) {
    if (has(DICT, core)) return DICT[core];
    if (core.length > 500) return null; // mô tả tweak dài → chỉ dịch nếu exact-match ở trên
    return translateDynamic(core);
  }

  /* ================== Trạng thái + lưu original ================== */
  const LANG_KEY = 'sakura-lang';
  let lang = 'vi';
  try { if (localStorage.getItem(LANG_KEY) === 'en') lang = 'en'; } catch (_) {}

  const origText = new WeakMap(); // TextNode → chuỗi gốc VI (trước khi dịch)
  const origAttr = new WeakMap(); // Element → { placeholder: orig, title: orig }

  /* ================== Dịch / khôi phục ================== */
  const SKIP_TAGS = { SCRIPT: 1, STYLE: 1, TEXTAREA: 1, INPUT: 1, PRE: 1, CODE: 1, NOSCRIPT: 1 };

  function translateTextNode(node) {
    const v = node.nodeValue;
    if (!v) return;
    const p = node.parentElement;
    if (p && SKIP_TAGS[p.tagName]) return;
    const core = v.trim();
    if (!core) return;
    const en = translateCore(core);
    if (!en || en === core) return;
    if (!origText.has(node)) origText.set(node, v);
    node.nodeValue = (/^\s*/.exec(v))[0] + en + (/\s*$/.exec(v))[0];
  }

  function translateAttrs(el) {
    if (!el.getAttribute) return;
    const names = ['placeholder', 'title'];
    for (let i = 0; i < names.length; i++) {
      const a = names[i];
      const v = el.getAttribute(a);
      if (!v) continue;
      const t = v.trim();
      if (!t || !has(DICT, t)) continue;
      const en = DICT[t];
      if (en === t) continue;
      let rec = origAttr.get(el);
      if (!rec) { rec = {}; origAttr.set(el, rec); }
      if (!(a in rec)) rec[a] = v;
      el.setAttribute(a, v.replace(t, en));
    }
  }

  function makeWalker(root) {
    return document.createTreeWalker(root, NodeFilter.SHOW_ELEMENT | NodeFilter.SHOW_TEXT, {
      acceptNode(n) {
        if (n.nodeType === 1) return SKIP_TAGS[n.tagName] ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_ACCEPT;
        const p = n.parentElement;
        return p && SKIP_TAGS[p.tagName] ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_ACCEPT;
      },
    });
  }

  function scanNow(root) {
    if (!root) return;
    const w = makeWalker(root);
    for (let n = w.nextNode(); n; n = w.nextNode()) {
      if (n.nodeType === 1) translateAttrs(n); else translateTextNode(n);
    }
  }

  function restoreNow(root) {
    if (!root) return;
    const w = makeWalker(root);
    for (let n = w.nextNode(); n; n = w.nextNode()) {
      if (n.nodeType === 1) {
        const rec = origAttr.get(n);
        if (rec) {
          const ks = Object.keys(rec);
          for (let i = 0; i < ks.length; i++) n.setAttribute(ks[i], rec[ks[i]]);
        }
      } else if (origText.has(n)) {
        n.nodeValue = origText.get(n);
      }
    }
  }

  /* ================== Observer + batch rAF ================== */
  const qText = new Set();
  const qSub = new Set();
  const qAttr = new Set();
  let rafId = 0;

  function flush() {
    rafId = 0;
    const subs = Array.from(qSub); qSub.clear();
    const texts = Array.from(qText); qText.clear();
    const attrs = Array.from(qAttr); qAttr.clear();
    for (let i = 0; i < subs.length; i++) if (subs[i].isConnected) scanNow(subs[i]);
    for (let i = 0; i < texts.length; i++) if (texts[i].isConnected) translateTextNode(texts[i]);
    for (let i = 0; i < attrs.length; i++) if (attrs[i].isConnected) translateAttrs(attrs[i]);
  }

  function schedule() {
    if (!rafId) rafId = requestAnimationFrame(flush);
  }

  const mo = new MutationObserver((muts) => {
    if (lang !== 'en') return;
    for (let i = 0; i < muts.length; i++) {
      const m = muts[i];
      if (m.type === 'characterData') {
        qText.add(m.target);
        schedule();
      } else if (m.type === 'childList') {
        for (let j = 0; j < m.addedNodes.length; j++) {
          const n = m.addedNodes[j];
          if (n.nodeType === 3) {
            const p = n.parentElement;
            if (p && !SKIP_TAGS[p.tagName]) { qText.add(n); schedule(); }
          } else if (n.nodeType === 1 && !SKIP_TAGS[n.tagName]) {
            qSub.add(n);
            schedule();
          }
        }
      } else if (m.type === 'attributes' && m.target && m.target.nodeType === 1) {
        qAttr.add(m.target);
        schedule();
      }
    }
  });

  /* ================== Nút chuyển ngôn ngữ ================== */
  function updateBtn() {
    const b = document.getElementById('sakuraI18nBtn');
    if (b) b.textContent = lang === 'vi' ? '🌐 EN' : '🌐 VI';
  }

  function injectBtn() {
    const bar = document.querySelector('.topbar');
    if (!bar || document.getElementById('sakuraI18nBtn')) return;
    const btn = document.createElement('button');
    btn.id = 'sakuraI18nBtn';
    btn.type = 'button';
    btn.title = 'Đổi ngôn ngữ / Switch language';
    btn.setAttribute('style',
      'flex:0 0 auto;background:transparent;border:1px solid rgba(255,255,255,.22);color:inherit;' +
      'font-family:inherit;font-size:13px;font-weight:600;line-height:1;padding:7px 12px;' +
      'border-radius:999px;cursor:pointer;opacity:.9;transition:background .15s ease,opacity .15s ease');
    btn.addEventListener('mouseenter', () => { btn.style.background = 'rgba(255,255,255,.08)'; btn.style.opacity = '1'; });
    btn.addEventListener('mouseleave', () => { btn.style.background = 'transparent'; btn.style.opacity = '.9'; });
    btn.addEventListener('click', () => applyLang(lang === 'vi' ? 'en' : 'vi'));
    const wrap = bar.querySelector('.badges-wrap');
    (wrap || bar).appendChild(btn);
    updateBtn();
  }

  /* ================== Persist lên server (an toàn, không fail UI) ================== */
  function persistLang() {
    try {
      fetch('/api/settings')
        .then((r) => (r.ok ? r.json() : null))
        .then((s) => {
          if (!s || typeof s !== 'object') return;
          return fetch('/api/settings', {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(Object.assign({}, s, { lang: lang })),
          });
        })
        .catch(() => {}); // server bỏ qua field lạ hoặc offline → vẫn dùng localStorage
    } catch (_) {}
  }

  /* ================== applyLang ================== */
  function applyLang(next) {
    lang = next === 'en' ? 'en' : 'vi';
    try { localStorage.setItem(LANG_KEY, lang); } catch (_) {}
    document.documentElement.setAttribute('lang', lang);
    qText.clear(); qSub.clear(); qAttr.clear();
    const root = document.body || document.documentElement;
    if (lang === 'en') {
      scanNow(root);
      // v3.4.0 fix: input/textarea là void element — không có text node nên sweep chính bỏ qua
      try {
        root.querySelectorAll('input[placeholder], textarea[placeholder]').forEach(translateAttrs);
      } catch (_) {}
    } else {
      restoreNow(root);
      // v3.4.0 fix: khôi phục placeholder gốc khi quay về VI
      try {
        root.querySelectorAll('input[placeholder], textarea[placeholder]').forEach((el) => {
          const rec = origAttr.get(el);
          if (rec && rec.placeholder) el.setAttribute('placeholder', rec.placeholder);
        });
      } catch (_) {}
    }
    updateBtn();
    persistLang();
  }

  /* ================== Init ================== */
  function init() {
    injectBtn();
    mo.observe(document.documentElement, {
      childList: true,
      characterData: true,
      subtree: true,
      attributes: true,
      attributeFilter: ['placeholder', 'title'],
    });
    if (lang === 'en') scanNow(document.body || document.documentElement);
    document.documentElement.setAttribute('lang', lang);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init, { once: true });
  } else {
    init();
  }
})();
