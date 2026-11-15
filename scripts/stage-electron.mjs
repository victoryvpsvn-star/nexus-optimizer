// Dựng thư mục đóng gói Electron (build/electron-app):
// - package.json tối giản (KHÔNG dependencies → electron-builder không kéo node_modules)
// - main.js, icon.ico, electron-builder.json
// - resources-src/standalone (bản Next standalone hoàn chỉnh) + resources-src/db (DB template)
// Sau bước này: cd build/electron-app && npx electron-builder --win --x64
import fs from 'fs'
import path from 'path'
import { cpSync, existsSync, mkdirSync, writeFileSync, rmSync } from 'fs'

const root = process.cwd()
const stage = path.join(root, 'build', 'electron-app')
const standaloneSrc = path.join(root, '.next', 'standalone')
const dbTemplate = process.env.NEXUS_DB_TEMPLATE || path.join(root, 'build', 'nexus.db')

if (!existsSync(path.join(standaloneSrc, 'server.js'))) {
  console.error('LỖI: .next/standalone/server.js không tồn tại — chạy `next build` trước.')
  process.exit(1)
}
if (!existsSync(dbTemplate)) {
  console.error(
    `LỖI: DB template không tồn tại: ${dbTemplate}\n` +
      'Trên CI hãy chạy: npx prisma db push với DATABASE_URL=file:<workspace>/build/nexus.db',
  )
  process.exit(1)
}

rmSync(stage, { recursive: true, force: true })
mkdirSync(path.join(stage, 'build'), { recursive: true })
mkdirSync(path.join(stage, 'resources-src'), { recursive: true })

const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'))
writeFileSync(
  path.join(stage, 'package.json'),
  JSON.stringify(
    {
      name: 'nexus-optimizer',
      productName: 'NEXUS Optimizer',
      version: pkg.version || '1.2.0',
      description: 'NEXUS Optimizer — Bộ công cụ hệ thống đa năng (Sakura Edition)',
      main: 'main.js',
      private: true,
    },
    null,
    2,
  ),
)

// main.js + icon
cpSync(path.join(root, 'electron', 'main.js'), path.join(stage, 'main.js'))
const icon = path.join(root, 'build', 'icon.ico')
if (existsSync(icon)) {
  cpSync(icon, path.join(stage, 'build', 'icon.ico'))
} else {
  console.warn('CẢNH BÁO: build/icon.ico không tồn tại — dùng icon mặc định Electron')
}

// Standalone hoàn chỉnh (đã qua post-build)
cpSync(standaloneSrc, path.join(stage, 'resources-src', 'standalone'), { recursive: true })

// DB template + schema.prisma (main.js dùng schema hash làm marker upgrade)
const dbDir = path.join(stage, 'resources-src', 'db')
mkdirSync(dbDir, { recursive: true })
cpSync(dbTemplate, path.join(dbDir, 'nexus.db'))
const schemaSrc = path.join(root, 'prisma', 'schema.prisma')
if (existsSync(schemaSrc)) {
  cpSync(schemaSrc, path.join(dbDir, 'schema.prisma'))
} else {
  console.error('LỖI: prisma/schema.prisma không tồn tại — không tạo được marker schema cho DB template')
  process.exit(1)
}

// electron-builder cần biết version Electron — đọc từ devDependencies của package.json gốc
const electronVersion = String(pkg.devDependencies?.electron || '^33.2.1').replace(/[^0-9.]/g, '')

// Cấu hình electron-builder — đường dẫn tương đối tính từ thư mục staging
writeFileSync(
  path.join(stage, 'electron-builder.json'),
  JSON.stringify(
    {
      appId: 'com.nexus.optimizer',
      productName: 'NEXUS Optimizer',
      electronVersion,
      asar: true,
      files: ['main.js', 'package.json'],
      directories: {
        output: '../../release',
        buildResources: 'build',
      },
      extraResources: [
        { from: 'resources-src/standalone', to: 'app' },
        { from: 'resources-src/db', to: 'db-template' },
      ],
      win: {
        target: [
          { target: 'nsis', arch: ['x64'] },
          { target: 'portable', arch: ['x64'] },
        ],
        icon: 'build/icon.ico',
      },
      nsis: {
        oneClick: false,
        allowToChangeInstallationDirectory: true,
        createDesktopShortcut: true,
        shortcutName: 'NEXUS Optimizer',
        artifactName: 'NEXUS-Optimizer-Setup-${version}-x64.${ext}',
      },
      portable: {
        artifactName: 'NEXUS-Optimizer-Portable-${version}-x64.${ext}',
      },
    },
    null,
    2,
  ),
)

console.log('stage-electron OK — build/electron-app sẵn sàng cho electron-builder')
