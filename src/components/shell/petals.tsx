'use client'

/**
 * Hiệu ứng cánh hoa sakura rơi — nền sáng Sakura.
 * Cấu hình cố định (không random lúc render) để tránh lệch hydration.
 * Tôn trọng prefers-reduced-motion qua rule toàn cục trong globals.css.
 */

interface PetalConfig {
  left: string // vị trí ngang %
  size: number // kích thước px
  duration: number // giây rơi từ trên xuống
  delay: number // giây trễ bắt đầu
  drift: string // độ lệch ngang khi rơi
  opacity: number
}

const PETALS: PetalConfig[] = [
  { left: '4%', size: 14, duration: 13.5, delay: 0, drift: '5vw', opacity: 0.75 },
  { left: '11%', size: 10, duration: 16, delay: 2.2, drift: '-4vw', opacity: 0.6 },
  { left: '18%', size: 16, duration: 12.5, delay: 5.1, drift: '6vw', opacity: 0.85 },
  { left: '26%', size: 9, duration: 18, delay: 1.4, drift: '-6vw', opacity: 0.55 },
  { left: '33%', size: 13, duration: 14.5, delay: 7.3, drift: '4vw', opacity: 0.7 },
  { left: '41%', size: 11, duration: 15.5, delay: 3.6, drift: '-5vw', opacity: 0.65 },
  { left: '49%', size: 15, duration: 12, delay: 9.0, drift: '7vw', opacity: 0.8 },
  { left: '57%', size: 10, duration: 17, delay: 0.8, drift: '-4vw', opacity: 0.6 },
  { left: '64%', size: 14, duration: 13, delay: 6.2, drift: '5vw', opacity: 0.75 },
  { left: '72%', size: 9, duration: 18.5, delay: 4.4, drift: '-6vw', opacity: 0.55 },
  { left: '79%', size: 13, duration: 14, delay: 10.5, drift: '4vw', opacity: 0.7 },
  { left: '86%', size: 16, duration: 12.8, delay: 2.9, drift: '6vw', opacity: 0.8 },
  { left: '92%', size: 11, duration: 16.5, delay: 8.1, drift: '-5vw', opacity: 0.6 },
  { left: '97%', size: 12, duration: 15, delay: 11.8, drift: '5vw', opacity: 0.65 },
]

export function Petals() {
  return (
    <div aria-hidden className="pointer-events-none absolute inset-0 overflow-hidden">
      {PETALS.map((p, i) => (
        <span
          key={i}
          className="petal"
          style={{
            left: p.left,
            width: p.size,
            height: p.size * 0.82,
            animationDuration: `${p.duration}s`,
            animationDelay: `${p.delay}s`,
            ['--petal-drift' as string]: p.drift,
            ['--petal-opacity' as string]: String(p.opacity),
          }}
        />
      ))}
    </div>
  )
}
