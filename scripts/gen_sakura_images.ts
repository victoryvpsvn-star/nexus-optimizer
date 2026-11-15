// Sinh ảnh sakura wallpaper + logo cho NEXUS OPTIMIZER (chạy bằng bun)
import ZAI from 'z-ai-web-dev-sdk'
import fs from 'fs'

async function gen(prompt: string, size: '1344x768' | '1024x1024', out: string) {
  const zai = await ZAI.create()
  const r = await zai.images.generations.create({ prompt, size })
  const b64 = r?.data?.[0]?.base64
  if (!b64) throw new Error('no base64 in response for ' + out)
  fs.writeFileSync(out, Buffer.from(b64, 'base64'))
  console.log('saved:', out, fs.statSync(out).size, 'bytes')
}

await gen(
  'Soft pastel sakura wallpaper, dreamy light pink cherry blossom branches in bloom along the top corners, gentle gradient from creamy white to blush rose, airy and bright, soft bokeh petals floating in the air, minimalist elegant anime background style, no text, high quality',
  '1344x768',
  'public/img/wall-sakura.png',
)
await gen(
  'Minimalist cute sakura flower logo icon, single pink cherry blossom with 5 rounded soft petals, pastel pink and white gradient, clean flat rounded design, centered on very light pink background, no text, app icon style, high quality',
  '1024x1024',
  'public/img/logo-sakura.png',
)
console.log('DONE')
