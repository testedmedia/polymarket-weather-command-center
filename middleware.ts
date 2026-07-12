import { NextRequest, NextResponse } from 'next/server'

// Cookie format: "<expiryMs>.<hex hmac of expiryMs>" signed with AUTH_SECRET.
// Everything except the login screen, the auth endpoint and static assets
// requires a valid, unexpired cookie.
const COOKIE = 'pwcc-auth'

const PUBLIC_PATHS = ['/login', '/api/auth', '/api/demo-status', '/icon.svg', '/testedmedia.svg', '/favicon.ico']

async function hmacHex(secret: string, message: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  )
  const sig = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(message))
  return Array.from(new Uint8Array(sig))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('')
}

export async function middleware(request: NextRequest) {
  const { pathname } = request.nextUrl
  if (pathname.startsWith('/_next') || PUBLIC_PATHS.some((p) => pathname === p || pathname.startsWith(p + '/'))) {
    return NextResponse.next()
  }

  const secret = process.env.AUTH_SECRET
  // If auth is not configured (e.g. local dev without env), stay open.
  if (!secret || !process.env.ACCESS_PASSWORD) return NextResponse.next()

  const token = request.cookies.get(COOKIE)?.value
  if (token) {
    const [exp, sig] = token.split('.')
    if (exp && sig && Number(exp) > Date.now()) {
      const expected = await hmacHex(secret, exp)
      if (sig.length === expected.length && sig === expected) return NextResponse.next()
    }
  }

  if (pathname.startsWith('/api/')) {
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 })
  }
  return NextResponse.redirect(new URL('/login', request.url))
}

export const config = {
  matcher: ['/((?!_next/static|_next/image).*)'],
}
