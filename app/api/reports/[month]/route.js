// GET  /api/reports/2026-11   -> the report as JSON
// POST /api/reports/2026-11   -> also posts it to the #management channel (cron: 1st of the month)
import { NextResponse } from 'next/server';
import { cronAuthorised } from '../../../../lib/auth.js';
import { getService } from '../../../../lib/container.js';

const parse = (m) => (/^\d{4}-(0[1-9]|1[0-2])$/.test(m) ? m.split('-').map(Number) : null);

export async function GET(_req, { params }) {
  const ym = parse((await params).month);
  if (!ym) return NextResponse.json({ error: 'use YYYY-MM' }, { status: 400 });
  return NextResponse.json(await (await getService()).monthlyReport(...ym));
}

export async function POST(req, { params }) {
  if (!cronAuthorised(req)) return NextResponse.json({ error: 'unauthorised' }, { status: 401 });
  const ym = parse((await params).month);
  if (!ym) return NextResponse.json({ error: 'use YYYY-MM' }, { status: 400 });
  return NextResponse.json(await (await getService()).publishMonthlyReport(...ym));
}
