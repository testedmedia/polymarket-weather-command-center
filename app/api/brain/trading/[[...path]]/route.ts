import { NextRequest, NextResponse } from 'next/server'
import { isDemoMode, getDemoData, getDemoSubroute } from '@/lib/demo-data'

// Read-only proxy to the upstream weather-intelligence API. The standalone
// Command Center has no database of its own — every panel is fed by the same
// public weather-intel payload the production engine builds every 15 minutes.
// GET only: this preview never mutates upstream state.
//
// DEMO MODE (see lib/demo-data.ts): when no UPSTREAM_BASE is configured (the
// out-of-the-box `npm run dev` experience) or DEMO=1 is set explicitly, this
// route serves a bundled synthetic sample payload instead of proxying — so
// the dashboard renders fully populated with zero env vars. Set DEMO=0 to
// force demo mode off even without UPSTREAM_BASE (surfaces the real 502
// instead of masking it).
const UPSTREAM_BASE = process.env.UPSTREAM_BASE ?? 'http://localhost:3000'

export const dynamic = 'force-dynamic'

export async function GET(req: NextRequest, { params }: { params: { path?: string[] } }) {
  const sub = params.path?.length ? `/${params.path.join('/')}` : ''

  if (isDemoMode()) {
    const search = req.nextUrl.searchParams
    if (sub) {
      return NextResponse.json(getDemoSubroute(sub, search))
    }
    const singleType = search.get('type')
    const multiTypes = search.get('types')
    if (multiTypes) {
      const out: Record<string, unknown> = {}
      for (const t of multiTypes.split(',').map((s) => s.trim()).filter(Boolean)) {
        out[t] = getDemoData(t, search)
      }
      return NextResponse.json(out)
    }
    if (singleType) {
      return NextResponse.json(getDemoData(singleType, search))
    }
    // No type/types param and no sub-path — mirror weather-intel as the
    // closest thing to a sane default response.
    return NextResponse.json(getDemoData('weather-intel', search))
  }

  const url = `${UPSTREAM_BASE}/api/brain/trading${sub}${req.nextUrl.search}`
  try {
    const headers: Record<string, string> = { accept: 'application/json' }
    // Server-side auth to the upstream engine — never exposed to the browser.
    if (process.env.UPSTREAM_SECRET) headers['authorization'] = `Bearer ${process.env.UPSTREAM_SECRET}`
    const res = await fetch(url, {
      cache: 'no-store',
      headers,
      signal: AbortSignal.timeout(55_000),
    })
    const body = await res.text()
    return new NextResponse(body, {
      status: res.status,
      headers: { 'content-type': res.headers.get('content-type') ?? 'application/json' },
    })
  } catch (e) {
    return NextResponse.json({ error: `upstream fetch failed: ${String(e)}` }, { status: 502 })
  }
}

export async function POST() {
  return NextResponse.json({ error: 'read-only preview' }, { status: 405 })
}
