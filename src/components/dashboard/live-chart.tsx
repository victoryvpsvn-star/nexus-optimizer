'use client'

import { memo, useMemo } from 'react'
import {
  Area,
  AreaChart,
  CartesianGrid,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts'
import type { HistoryPoint } from '@/hooks/use-stats'

function LiveChartInner({ history }: { history: HistoryPoint[] }) {
  const data = useMemo(
    () =>
      history.map((h, i) => ({
        ...h,
        idx: i,
        cpu: +h.cpu.toFixed(1),
        ram: +h.ram.toFixed(1),
      })),
    [history],
  )

  return (
    <div className="h-[240px] w-full">
      <ResponsiveContainer width="100%" height="100%">
        <AreaChart data={data} margin={{ top: 10, right: 8, bottom: 0, left: 0 }}>
          <defs>
            <linearGradient id="gCpu" x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor="var(--accent-1)" stopOpacity={0.35} />
              <stop offset="100%" stopColor="var(--accent-1)" stopOpacity={0} />
            </linearGradient>
            <linearGradient id="gRam" x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor="var(--accent-2)" stopOpacity={0.3} />
              <stop offset="100%" stopColor="var(--accent-2)" stopOpacity={0} />
            </linearGradient>
          </defs>
          <CartesianGrid stroke="rgba(255,255,255,0.06)" strokeDasharray="3 6" vertical={false} />
          <XAxis dataKey="idx" hide />
          <YAxis domain={[0, 100]} hide />
          <Tooltip
            cursor={{ stroke: 'rgba(255,255,255,0.2)', strokeDasharray: '4 4' }}
            contentStyle={{
              background: 'color-mix(in srgb, var(--popover) 92%, transparent)',
              border: '1px solid rgba(255,255,255,0.1)',
              borderRadius: 12,
              fontSize: 12,
              color: '#f4f4f5',
            }}
            labelFormatter={() => ''}
            formatter={(value: number | string, name: string) => [
              `${value}%`,
              name === 'cpu' ? 'CPU' : 'RAM',
            ]}
          />
          <Area
            type="monotone"
            dataKey="cpu"
            stroke="var(--accent-1)"
            strokeWidth={2}
            fill="url(#gCpu)"
            isAnimationActive={false}
            dot={false}
          />
          <Area
            type="monotone"
            dataKey="ram"
            stroke="var(--accent-2)"
            strokeWidth={2}
            fill="url(#gRam)"
            isAnimationActive={false}
            dot={false}
          />
        </AreaChart>
      </ResponsiveContainer>
    </div>
  )
}

export const LiveChart = memo(LiveChartInner)
