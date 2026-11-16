'use client'

import { Card } from '@/components/ui/card'
import type { LucideIcon } from 'lucide-react'
import type { ReactNode } from 'react'

interface StatCardProps {
  icon: LucideIcon
  title: string
  accent?: '1' | '2'
  children: ReactNode
  className?: string
}

export function StatCard({ icon: Icon, title, accent = '1', children, className = '' }: StatCardProps) {
  return (
    <Card className={`glass glow-hover rounded-2xl border p-4 ${className}`}>
      <div className="mb-3 flex items-center gap-2">
        <span
          className="flex h-8 w-8 items-center justify-center rounded-xl"
          style={{
            background: `color-mix(in srgb, var(--accent-${accent}) 18%, transparent)`,
            color: `var(--accent-${accent})`,
          }}
        >
          <Icon className="h-4 w-4" />
        </span>
        <span className="text-xs font-semibold uppercase tracking-widest text-zinc-400">
          {title}
        </span>
      </div>
      {children}
    </Card>
  )
}
