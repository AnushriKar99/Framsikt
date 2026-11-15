// Chat-tool webhook. The chat tool turns button clicks / slash commands into these actions.
//   {action:'empty', office, userId}              anyone: "the box is empty"
//   {action:'accept'|'decline', refillId, userId}
//   {action:'receipt', refillId, userId, amount, currency, receipt, items?}
//   {action:'away', userId, until|null}           {action:'visiting', userId, office, until}
//   {action:'review', refillId, approve}          office admin
import { NextResponse } from 'next/server';
import { chatAuthorised } from '../../../lib/auth.js';
import { getService } from '../../../lib/container.js';
import { RefillError } from '../../../lib/snackbot/model.js';

const date = (v) => (v ? new Date(v) : null);

export async function POST(req) {
  if (!chatAuthorised(req)) return NextResponse.json({ error: 'unauthorised' }, { status: 401 });
  const b = await req.json();
  const svc = await getService();
  try {
    switch (b.action) {
      case 'empty': return NextResponse.json(await svc.reportEmpty(b.office, b.userId));
      case 'accept': return NextResponse.json(await svc.accept(b.refillId, b.userId));
      case 'decline': return NextResponse.json(await svc.decline(b.refillId, b.userId));
      case 'receipt':
        return NextResponse.json(await svc.submitReceipt(b.refillId, b.userId, b.amount, b.currency, b.receipt, b.items));
      case 'away': await svc.setAway(b.userId, date(b.until)); return NextResponse.json({ ok: true });
      case 'visiting': await svc.setVisiting(b.userId, b.office, date(b.until)); return NextResponse.json({ ok: true });
      case 'review': return NextResponse.json(await svc.resolveReview(b.refillId, !!b.approve));
      default: return NextResponse.json({ error: 'unknown action' }, { status: 400 });
    }
  } catch (e) {
    if (e instanceof RefillError) return NextResponse.json({ error: e.message }, { status: 409 });
    console.error(e);
    return NextResponse.json({ error: 'internal error' }, { status: 500 });
  }
}
