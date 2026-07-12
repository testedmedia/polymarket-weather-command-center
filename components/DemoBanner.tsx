'use client'

import { useEffect, useState } from 'react'

// Thin, dismissible banner so nobody mistakes the bundled sample payload
// (lib/demo-data.ts) for a live trading account. Fetches /api/demo-status
// once on mount; renders nothing once dismissed or when demo mode is off.
export default function DemoBanner() {
  const [demo, setDemo] = useState(false)
  const [dismissed, setDismissed] = useState(false)

  useEffect(() => {
    let cancelled = false
    fetch('/api/demo-status')
      .then((r) => r.json())
      .then((d) => {
        if (!cancelled && d?.demo) setDemo(true)
      })
      .catch(() => {})
    return () => {
      cancelled = true
    }
  }, [])

  if (!demo || dismissed) return null

  return (
    <div className="sticky top-0 z-[100] flex items-center justify-center gap-3 bg-amber-500 px-4 py-2 text-center text-xs font-semibold text-black">
      <span>
        DEMO MODE — every number on this page is a bundled synthetic sample (see{' '}
        <code className="rounded bg-black/10 px-1">lib/demo-data.ts</code>), not a live trade or account. Set{' '}
        <code className="rounded bg-black/10 px-1">UPSTREAM_BASE</code> to point at your own engine.
      </span>
      <button
        onClick={() => setDismissed(true)}
        className="rounded bg-black/10 px-2 py-0.5 hover:bg-black/20"
        aria-label="Dismiss demo mode banner"
      >
        Dismiss
      </button>
    </div>
  )
}
