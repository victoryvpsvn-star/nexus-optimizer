# Sakura Tool — Tauri shell (EXPERIMENTAL)

Shell desktop bằng Rust/Tauri 2 bọc lại web UI Sakura Tool.
Yêu cầu: Rust toolchain + Node (tauri-cli). Build: `cargo tauri build` trong `src-tauri/`.
main.rs tự tìm `Sakura-Tool-Go.exe` cạnh exe để chạy server Go rồi mở cửa sổ native đẹp hơn.
File này KHÔNG build trong sandbox Linux (không có Rust toolchain) — build qua workflow build-rust.yml trên GitHub Actions hoặc máy bạn.
