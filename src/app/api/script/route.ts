// API Script nâng cao (Advanced) — lưu / liệt kê / chạy / xóa script tùy chỉnh
import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { z } from 'zod'
import {
  DEFAULT_TIMEOUT_MS,
  MAX_CODE_CHARS,
  runScriptCode,
  supportedLanguages,
} from '@/lib/scripts'
import type { ScriptLanguage, ScriptRecord } from '@/lib/types'

export const dynamic = 'force-dynamic'

const LANGS = ['bash', 'python', 'powershell'] as const

const saveSchema = z.object({
  name: z.string().trim().min(1, 'Thiếu tên script').max(60, 'Tên script tối đa 60 ký tự'),
  language: z.enum(LANGS),
  code: z.string().min(1, 'Thiếu nội dung script').max(MAX_CODE_CHARS, `Script tối đa ${MAX_CODE_CHARS} ký tự`),
})

const putSchema = z.discriminatedUnion('action', [
  z.object({ action: z.literal('run'), id: z.number().int().positive() }),
  z.object({
    action: z.literal('run-direct'),
    language: z.enum(LANGS),
    code: z.string().min(1, 'Thiếu nội dung script').max(MAX_CODE_CHARS, `Script tối đa ${MAX_CODE_CHARS} ký tự`),
    timeoutMs: z.number().int().min(1000).max(180_000).optional(),
  }),
])

function toRecord(r: { id: number; name: string; language: string; code: string; updatedAt: Date }): ScriptRecord {
  return {
    id: r.id,
    name: r.name,
    language: r.language as ScriptLanguage,
    code: r.code,
    updatedAt: r.updatedAt.toISOString(),
  }
}

export async function GET() {
  try {
    const rows = await db.savedScript.findMany({
      orderBy: { updatedAt: 'desc' },
      take: 50,
    })
    return NextResponse.json({
      scripts: rows.map(toRecord),
      languages: supportedLanguages(),
    })
  } catch (e) {
    console.error('[api/script GET]', e)
    return NextResponse.json({ error: 'Không tải được danh sách script' }, { status: 500 })
  }
}

export async function POST(req: NextRequest) {
  try {
    const raw: unknown = await req.json().catch(() => null)
    if (raw === null) {
      return NextResponse.json({ error: 'Dữ liệu không hợp lệ' }, { status: 400 })
    }
    const body = saveSchema.safeParse(raw)
    if (!body.success) {
      return NextResponse.json(
        { error: body.error.issues[0]?.message ?? 'Dữ liệu script không hợp lệ' },
        { status: 400 },
      )
    }
    const record = await db.savedScript.create({
      data: { name: body.data.name, language: body.data.language, code: body.data.code },
    })
    return NextResponse.json({ script: toRecord(record) })
  } catch (e) {
    console.error('[api/script POST]', e)
    return NextResponse.json({ error: 'Không lưu được script' }, { status: 500 })
  }
}

export async function PUT(req: NextRequest) {
  try {
    const raw: unknown = await req.json().catch(() => null)
    if (raw === null) {
      return NextResponse.json({ error: 'Dữ liệu không hợp lệ' }, { status: 400 })
    }
    const body = putSchema.safeParse(raw)
    if (!body.success) {
      return NextResponse.json(
        { error: body.error.issues[0]?.message ?? 'Yêu cầu chạy script không hợp lệ' },
        { status: 400 },
      )
    }

    if (body.data.action === 'run-direct') {
      const r = await runScriptCode(body.data.code, body.data.language, body.data.timeoutMs ?? DEFAULT_TIMEOUT_MS)
      return NextResponse.json(r)
    }

    // action === 'run' — chạy script đã lưu
    const record = await db.savedScript.findUnique({ where: { id: body.data.id } })
    if (!record) {
      return NextResponse.json({ error: 'Không tìm thấy script đã lưu' }, { status: 404 })
    }
    const r = await runScriptCode(record.code, record.language as ScriptLanguage, DEFAULT_TIMEOUT_MS)
    return NextResponse.json(r)
  } catch (e) {
    console.error('[api/script PUT]', e)
    return NextResponse.json({ error: 'Chạy script thất bại' }, { status: 500 })
  }
}

export async function DELETE(req: NextRequest) {
  try {
    const id = Number(req.nextUrl.searchParams.get('id'))
    if (!Number.isInteger(id) || id <= 0) {
      return NextResponse.json({ error: 'id không hợp lệ' }, { status: 400 })
    }
    const found = await db.savedScript.findUnique({ where: { id } })
    if (!found) {
      return NextResponse.json({ error: 'Không tìm thấy script đã lưu' }, { status: 404 })
    }
    await db.savedScript.delete({ where: { id } })
    return NextResponse.json({ success: true })
  } catch (e) {
    console.error('[api/script DELETE]', e)
    return NextResponse.json({ error: 'Không xóa được script' }, { status: 500 })
  }
}
