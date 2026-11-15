// Hoàn tất build Next.js standalone theo cách đa nền tảng (Windows + Linux):
// - copy .next/static + public vào .next/standalone
// - copy @prisma/.prisma engine vào standalone (Next trace không luôn đủ)
// - copy scripts/s3_sidecar.py (sidecar bucket) vào standalone
import fs from 'fs'
import path from 'path'
import { cpSync, existsSync, mkdirSync } from 'fs'

const root = process.cwd()
const sa = path.join(root, '.next', 'standalone')

if (!existsSync(path.join(sa, 'server.js'))) {
  console.error('LỖI: .next/standalone/server.js không tồn tại — hãy chạy `next build` (output: standalone) trước.')
  process.exit(1)
}

// 1. Static assets
cpSync(path.join(root, '.next', 'static'), path.join(sa, '.next', 'static'), { recursive: true })

// 2. Public (ảnh nền sakura, logo...)
cpSync(path.join(root, 'public'), path.join(sa, 'public'), { recursive: true })

// 3. Prisma engine + client (engine native của đúng nền tảng build)
const srcPrisma = path.join(root, 'node_modules', '.prisma')
if (existsSync(srcPrisma)) {
  cpSync(srcPrisma, path.join(sa, 'node_modules', '.prisma'), { recursive: true })
}
const srcPrismaClient = path.join(root, 'node_modules', '@prisma')
if (existsSync(srcPrismaClient)) {
  cpSync(srcPrismaClient, path.join(sa, 'node_modules', '@prisma'), { recursive: true })
}

// 4. Sidecar bucket (backup S3)
const saScripts = path.join(sa, 'scripts')
mkdirSync(saScripts, { recursive: true })
const sidecar = path.join(root, 'scripts', 's3_sidecar.py')
if (existsSync(sidecar)) {
  cpSync(sidecar, path.join(saScripts, 's3_sidecar.py'))
}

console.log('post-build OK — standalone đã sẵn sàng')
