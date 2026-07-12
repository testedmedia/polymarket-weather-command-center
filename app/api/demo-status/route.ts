import { NextResponse } from 'next/server'
import { isDemoMode } from '@/lib/demo-data'

export const dynamic = 'force-dynamic'

export async function GET() {
  return NextResponse.json({ demo: isDemoMode() })
}
