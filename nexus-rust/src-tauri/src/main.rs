// Sakura Tool — Tauri shell (experimental)
// Tự chạy Go server cạnh exe rồi mở cửa sổ native; nếu thiếu Go exe thì báo lỗi rõ.
use std::process::{Command, Stdio};
use tauri::{WebviewUrl, WebviewWindowBuilder};

fn main() {
    let port: u16 = 38766;
    let go_exe = {
        let dir = std::env::current_exe().ok().and_then(|p| p.parent().map(|d| d.to_path_buf()));
        dir.map(|d| d.join("Sakura-Tool-Go.exe")).filter(|p| p.exists())
    };
    if let Some(exe) = go_exe {
        let _ = Command::new(exe)
            .arg("--port").arg(port.to_string())
            .arg("--web")
            .stdout(Stdio::null()).stderr(Stdio::null())
            .spawn();
        std::thread::sleep(std::time::Duration::from_millis(1200));
    }
    tauri::Builder::default()
        .setup(move |app| {
            let url = format!("http://127.0.0.1:{}", port);
            WebviewWindowBuilder::new(app, "sakura", WebviewUrl::External(url.parse().unwrap()))
                .title("Sakura Tool v3.0.0")
                .inner_size(1360.0, 860.0)
                .min_inner_size(960.0, 640.0)
                .center()
                .build()?;
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("Sakura Tool lỗi khi khởi động");
}
