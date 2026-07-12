import type { Metadata } from 'next'
import './globals.css'
import DemoBanner from '@/components/DemoBanner'

export const metadata: Metadata = {
  title: 'Polymarket Weather Command Center',
  description:
    'Live weather intelligence for Polymarket highest-temperature markets: multi-model forecasts, live station observations, bucket probabilities, and edge vs market price across 41 cities.',
}

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>
        <DemoBanner />
        <div className="max-w-[1400px] mx-auto">{children}</div>
      </body>
    </html>
  )
}
