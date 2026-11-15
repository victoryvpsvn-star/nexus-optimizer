'use client'

interface GaugeProps {
  value: number // 0-100
  label: string
  sub?: string
  size?: number
  accent?: string
}

// Màu ngưỡng dùng chung: <60 emerald / <85 amber / còn lại đỏ — Gauge và bảng tiến trình dùng chung
export function thresholdColor(v: number): string {
  if (v < 60) return '#34d399'
  if (v < 85) return '#fbbf24'
  return '#f43f5e'
}

export function Gauge({ value, label, sub, size = 160, accent }: GaugeProps) {
  const pct = Math.min(100, Math.max(0, value))
  const color = accent ?? thresholdColor(pct)
  const r = 44
  const c = 2 * Math.PI * r
  const arcLen = (240 / 360) * c
  const filled = (pct / 100) * arcLen

  return (
    <div className="flex flex-col items-center gap-2">
      <div className="relative" style={{ width: size, height: size * 0.82 }}>
        <svg
          width={size}
          height={size * 0.82}
          viewBox={`0 0 ${size} ${size * 0.82}`}
          className="overflow-visible"
        >
          <g transform={`translate(${size / 2}, ${size / 2}) rotate(150)`}>
            <circle
              r={r}
              fill="none"
              stroke="rgba(255,255,255,0.09)"
              strokeWidth={10}
              strokeLinecap="round"
              strokeDasharray={`${arcLen} ${c - arcLen}`}
            />
            <circle
              r={r}
              fill="none"
              stroke={color}
              strokeWidth={10}
              strokeLinecap="round"
              strokeDasharray={`${filled} ${c - filled}`}
              style={{
                filter: `drop-shadow(0 0 6px ${color}66)`,
                transition: 'stroke-dasharray 0.6s ease-out, stroke 0.4s',
              }}
            />
          </g>
        </svg>
        <div className="absolute inset-0 flex flex-col items-center justify-center pt-3">
          <span className="num text-3xl font-bold" style={{ color }}>
            {Math.round(pct)}
            <span className="text-sm text-zinc-400">%</span>
          </span>
          {sub && <span className="num mt-0.5 text-[11px] text-zinc-400">{sub}</span>}
        </div>
      </div>
      <span className="text-xs font-semibold uppercase tracking-widest text-zinc-400">
        {label}
      </span>
    </div>
  )
}
