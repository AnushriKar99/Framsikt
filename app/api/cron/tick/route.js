// Call every ~5 minutes (Vercel Cron, system cron, k8s CronJob...). All time-based work lives here.
import { NextResponse } from 'next/server';
import { cronAuthorised } from '../../../../lib/auth.js';
import { getService } from '../../../../lib/container.js';

export async function POST(req) {
  if (!cronAuthorised(req)) return NextResponse.json({ error: 'unauthorised' }, { status: 401 });
  await (await getService()).tick();
  return NextResponse.json({ ok: true });
}
