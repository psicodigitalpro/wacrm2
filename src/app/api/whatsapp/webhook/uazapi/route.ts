import { NextResponse } from 'next/server'

/**
 * TEMPORARY diagnostic capture for uazapi's inbound webhook payload
 * shape — Phase 3 of the uazapi provider work is blocked on seeing one
 * real delivery, since uazapi's docs don't publish the payload format.
 *
 * POST stores the last raw delivery in memory; GET returns it. Once the
 * real shape is confirmed, this route is replaced by the real handler
 * (parse uazapi's payload into a NormalizedInboundMessage and call the
 * shared inbound pipeline — see the provider plan).
 *
 * In-memory only: fine for a single manual test against a long-running
 * Node process (this app's Hostinger deploy), not meant to survive a
 * restart or multiple instances.
 */
let lastCapture: {
  receivedAt: string
  headers: Record<string, string>
  body: string
} | null = null

export async function POST(request: Request) {
  const body = await request.text()
  const headers: Record<string, string> = {}
  request.headers.forEach((value, key) => {
    headers[key] = value
  })

  lastCapture = { receivedAt: new Date().toISOString(), headers, body }
  console.log('[uazapi-webhook-capture]', JSON.stringify(lastCapture))

  return NextResponse.json({ status: 'received' })
}

export async function GET() {
  return NextResponse.json(lastCapture ?? { message: 'no capture yet' })
}
