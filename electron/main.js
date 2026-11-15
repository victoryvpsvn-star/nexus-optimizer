// NEXUS Optimizer — Electron wrapper cho bản Windows x64
// Khởi động Next.js standalone server (ELECTRON_RUN_AS_NODE) rồi mở cửa sổ app.
const { app, BrowserWindow, dialog, shell } = require('electron')
const { spawn } = require('child_process')
const http = require('http')
const path = require('path')
const fs = require('fs')
const crypto = require('crypto')

const PORT = 32123
const BASE_URL = `http://127.0.0.1:${PORT}`
let serverProc = null
let win = null
let quitting = false

/** server.js của bản build standalone: trong package đóng gói nằm ở resources/app */
function serverEntry() {
  if (app.isPackaged) return path.join(process.resourcesPath, 'app', 'server.js')
  return path.join(__dirname, '..', '.next', 'standalone', 'server.js')
}

/** Thư mục dữ liệu người dùng (DB SQLite, backups, restored) */
function dataDir() {
  return path.join(app.getPath('userData'), 'data')
}

/** Hash của schema.prisma trong template — dùng làm marker phiên bản schema DB */
function templateSchemaHash(templateDir) {
  try {
    const schemaPath = path.join(templateDir, 'schema.prisma')
    if (!fs.existsSync(schemaPath)) return null
    return crypto.createHash('md5').update(fs.readFileSync(schemaPath)).digest('hex')
  } catch {
    return null
  }
}

/**
 * Copy DB template (được tạo lúc build bằng prisma db push) vào userData lần đầu chạy;
 * nếu app mới ship schema KHÁC database cũ (update version) → backup DB cũ thành
 * nexus.db.bak-<timestamp> rồi dùng template mới (tránh Prisma lỗi thiếu table/cột).
 */
function ensureDatabase() {
  const dir = dataDir()
  fs.mkdirSync(dir, { recursive: true })
  const target = path.join(dir, 'nexus.db')
  const templateDir = app.isPackaged
    ? path.join(process.resourcesPath, 'db-template')
    : path.join(__dirname, '..', 'build', 'db-template')
  const templateDb = path.join(templateDir, 'nexus.db')
  if (!fs.existsSync(target)) {
    try {
      if (fs.existsSync(templateDb)) fs.copyFileSync(templateDb, target)
    } catch (e) {
      console.error('[nexus] copy db template thất bại:', e)
    }
  } else {
    // Upgrade path: schema mới khác schema cũ đang dùng → backup + thay template mới
    const schemaHash = templateSchemaHash(templateDir)
    const markerFile = path.join(dir, 'db-version.json')
    let marker = null
    try {
      marker = JSON.parse(fs.readFileSync(markerFile, 'utf8'))
    } catch {
      /* chưa có marker — lần đầu cài qua version mới */
    }
    if (schemaHash && (!marker || marker.schema !== schemaHash)) {
      const bak = path.join(dir, `nexus.db.bak-${Date.now()}`)
      try {
        fs.renameSync(target, bak)
        fs.copyFileSync(templateDb, target)
        console.log(`[nexus] schema thay đổi — DB cũ đã backup tại: ${bak}`)
      } catch (e) {
        console.error('[nexus] upgrade db thất bại:', e)
        // rename có thể thành công nhưng copy thất bại — khôi phục nếu cần
        if (!fs.existsSync(target) && fs.existsSync(bak)) {
          try {
            fs.renameSync(bak, target)
          } catch {
            /* để lỗi lộ ra ngoài */
          }
        }
      }
    }
  }
  // Ghi marker schema hiện tại
  const schemaHash = templateSchemaHash(templateDir)
  if (schemaHash) {
    try {
      fs.writeFileSync(
        path.join(dir, 'db-version.json'),
        JSON.stringify({ schema: schemaHash, at: new Date().toISOString() }),
      )
    } catch {
      /* không ghi được marker thì lần sau sẽ lại upgrade — an toàn hơn ngược lại */
    }
  }
  return target
}

function startServer(dbFile) {
  const entry = serverEntry()
  if (!fs.existsSync(entry)) {
    dialog.showErrorBox(
      'NEXUS Optimizer — thiếu file server',
      `Không tìm thấy:\n${entry}\n\nBản cài đặt có thể bị thiếu file. Hãy tải lại bản cài đặt đầy đủ.`,
    )
    app.quit()
    return false
  }
  serverProc = spawn(process.execPath, [entry], {
    cwd: path.dirname(entry),
    windowsHide: true,
    env: {
      ...process.env,
      ELECTRON_RUN_AS_NODE: '1',
      NODE_ENV: 'production',
      PORT: String(PORT),
      HOSTNAME: '127.0.0.1',
      // SQLite file nằm ở userData — nơi người dùng luôn có quyền ghi
      DATABASE_URL: 'file:' + dbFile.replace(/\\/g, '/'),
      NEXUS_DATA_DIR: dataDir(),
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  serverProc.stdout?.on('data', (d) => process.stdout.write('[srv] ' + d))
  serverProc.stderr?.on('data', (d) => process.stderr.write('[srv] ' + d))
  serverProc.on('exit', (code) => {
    serverProc = null
    if (!quitting) {
      // Server chết đột tử → đóng app thay vì treo cửa sổ trắng
      dialog.showErrorBox(
        'NEXUS Optimizer đã dừng',
        `Tiến trình server thoát đột ngột (mã ${code ?? 'không rõ'}).\nHãy mở lại ứng dụng.`,
      )
      app.quit()
    }
  })
  return true
}

/** Chờ server trả 2xx/4xx từ /api/stats (4xx nghĩa là server đã lên nhưng auth lỗi — vẫn cho mở) */
function waitReady(timeoutMs = 45000) {
  const t0 = Date.now()
  return new Promise((resolve, reject) => {
    const once = () => {
      if (quitting) return reject(new Error('đã thoát'))
      const req = http.get(`${BASE_URL}/api/stats`, (res) => {
        res.resume()
        if (!res.statusCode || res.statusCode < 500) return resolve()
        retry()
      })
      req.on('error', retry)
      req.setTimeout(2500, () => {
        req.destroy()
        retry()
      })
    }
    const retry = () => {
      if (Date.now() - t0 > timeoutMs) return reject(new Error('server không phản hồi'))
      setTimeout(once, 500)
    }
    once()
  })
}

function createWindow() {
  win = new BrowserWindow({
    width: 1440,
    height: 920,
    minWidth: 1080,
    minHeight: 700,
    backgroundColor: '#ffe4ec',
    autoHideMenuBar: true,
    show: false,
    title: 'NEXUS Optimizer',
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      spellcheck: false,
    },
  })
  win.once('ready-to-show', () => win.show())
  // Link ngoài mở bằng trình duyệt mặc định, không cho mở window mới trong app
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//i.test(url)) shell.openExternal(url)
    return { action: 'deny' }
  })
  win.on('closed', () => {
    win = null
  })
  win.loadURL(BASE_URL)
}

const gotLock = app.requestSingleInstanceLock()
if (!gotLock) {
  app.quit()
} else {
  app.on('second-instance', () => {
    if (win) {
      if (win.isMinimized()) win.restore()
      win.focus()
    }
  })

  app.whenReady().then(async () => {
    const dbFile = ensureDatabase()
    if (!startServer(dbFile)) return
    try {
      await waitReady()
    } catch (e) {
      dialog.showErrorBox(
        'NEXUS Optimizer — không khởi động được',
        `Server nội bộ không trả lời sau 45 giây.\n\n${String(e && e.message ? e.message : e)}\n\nHãy thử mở lại ứng dụng, hoặc kiểm tra cổng ${PORT} có bị chiếm không.`,
      )
      app.quit()
      return
    }
    createWindow()
  })

  app.on('window-all-closed', () => {
    app.quit()
  })

  app.on('before-quit', () => {
    quitting = true
    if (serverProc && !serverProc.killed) {
      try {
        if (process.platform === 'win32') {
          // Giết cả cây tiến trình (server.js có thể spawn con)
          spawn('taskkill', ['/pid', String(serverProc.pid), '/T', '/F'], { windowsHide: true })
        } else {
          serverProc.kill('SIGTERM')
        }
      } catch {
        /* bỏ qua */
      }
    }
  })
}
