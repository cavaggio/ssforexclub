import { NextResponse } from 'next/server';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export async function GET() {
  const baseUrl = process.env.SCANNER_BASE_URL;
  if (!baseUrl) {
    return NextResponse.json(
      { ok: false, error: 'SCANNER_BASE_URL is not configured on Vercel' },
      { status: 500 },
    );
  }

  try {
    const response = await fetch(`${baseUrl}/api/health`, { cache: 'no-store' });
    const text = await response.text();
    let payload: unknown = text;
    try {
      payload = text ? JSON.parse(text) : null;
    } catch {
      // Preserve non-JSON diagnostic output.
    }

    return NextResponse.json({
      ok: response.ok,
      scannerStatus: response.status,
      scanner: payload,
    }, { status: response.ok ? 200 : 503 });
  } catch (error) {
    return NextResponse.json({
      ok: false,
      error: error instanceof Error ? error.message : String(error),
    }, { status: 502 });
  }
}
