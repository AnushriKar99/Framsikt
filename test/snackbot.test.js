import assert from 'node:assert/strict';
import { beforeEach, describe, it } from 'node:test';

import { OFFICES } from '../lib/snackbot/config.js';
import { FakeChat, FakeClock, FakeHR, FixedRates } from '../lib/snackbot/fakes.js';
import { MemoryStore } from '../lib/snackbot/memoryStore.js';
import { BudgetExhausted, NotAllowed, State, blankRefill } from '../lib/snackbot/model.js';
import { createService } from '../lib/snackbot/service.js';

const OSLO = 'Oslo', BLR = 'Bengaluru';
let clock, chat, hr, store, svc;

beforeEach(() => {
  clock = new FakeClock(Date.UTC(2026, 10, 2, 9, 0));            // a Monday
  chat = new FakeChat();
  hr = new FakeHR(clock, 3);
  store = new MemoryStore({ users: [
    ...['o1', 'o2', 'o3'].map((id) => ({ id, homeOffice: OSLO, payrollCurrency: 'NOK' })),
    ...['b1', 'b2'].map((id) => ({ id, homeOffice: BLR, payrollCurrency: 'INR' })),
  ] });
  svc = createService({ store, chat, hr, clock, offices: OFFICES,
    rates: new FixedRates({ 'INR->NOK': '0.125' }) });
});

const R = (id) => svc.getRefill(id);
/** report -> assignee accepts -> assignee submits receipt. Returns the refill id. */
async function buy(office = OSLO, amount = '1000', currency = 'NOK', items) {
  const r = await svc.reportEmpty(office, 'someone');
  assert.equal(r.state, State.OFFERED);
  await svc.accept(r.id, r.assignee);
  await svc.submitReceipt(r.id, r.assignee, amount, currency, 'img.jpg', items);
  return r.id;
}
const away = (ids) => Promise.all(ids.map((id) => svc.setAway(id, new Date(clock.now().getTime() + 3 * 86400e3))));
const back = (ids) => Promise.all(ids.map((id) => svc.setAway(id, null)));
const OSLO_IDS = ['o1', 'o2', 'o3'];

describe('no duplicates', () => {
  it('duplicate reports give one refill and one ask', async () => {
    const a = await svc.reportEmpty(OSLO, 'x');
    const b = await svc.reportEmpty(OSLO, 'y');
    assert.equal(a.id, b.id);
    assert.equal((await svc.listRefills({})).length, 1);
    assert.equal(chat.direct.filter(([, t]) => t.includes('snack box is empty')).length, 1);
  });

  it('offices are independent', async () => {
    const a = await svc.reportEmpty(OSLO, 'x'), b = await svc.reportEmpty(BLR, 'y');
    assert.notEqual(a.id, b.id);
  });

  it('new report allowed once the box was refilled, even if HR is still pending', async () => {
    await buy();
    assert.equal((await svc.reportEmpty(OSLO, 'x')).state, State.OFFERED);
  });
});

describe('commit rules', () => {
  it('only the person asked can accept', async () => {
    const r = await svc.reportEmpty(OSLO, 'x');
    const other = r.assignee === 'o1' ? 'o2' : 'o1';
    await assert.rejects(svc.accept(r.id, other), NotAllowed);
    await svc.accept(r.id, r.assignee);
    assert.equal((await R(r.id)).state, State.COMMITTED);
  });

  it('a second person cannot commit after the first', async () => {
    await away(OSLO_IDS);
    const r = await svc.reportEmpty(OSLO, 'x');
    assert.equal(r.state, State.OPEN);
    await back(OSLO_IDS);
    await svc.accept(r.id, 'o2');
    await assert.rejects(svc.accept(r.id, 'o1'), NotAllowed);
    assert.equal((await R(r.id)).assignee, 'o2');
  });

  it('simultaneous accepts: exactly one winner', async () => {
    await away(OSLO_IDS);
    const r = await svc.reportEmpty(OSLO, 'x');
    await back(OSLO_IDS);
    const res = await Promise.allSettled(OSLO_IDS.map((u) => svc.accept(r.id, u)));
    const won = res.filter((x) => x.status === 'fulfilled');
    const lost = res.filter((x) => x.status === 'rejected');
    assert.equal(won.length, 1);
    assert.equal(lost.length, 2);
    lost.forEach((x) => assert.ok(x.reason instanceof NotAllowed));
    assert.equal((await R(r.id)).assignee, won[0].value.assignee);
  });

  it('receipt only from the committer, in the office currency, with an image', async () => {
    const r = await svc.reportEmpty(OSLO, 'x');
    await svc.accept(r.id, r.assignee);
    const other = r.assignee === 'o1' ? 'o2' : 'o1';
    await assert.rejects(svc.submitReceipt(r.id, other, '500', 'NOK', 'img'), NotAllowed);
    await assert.rejects(svc.submitReceipt(r.id, r.assignee, '500', 'INR', 'img'), NotAllowed);
    await assert.rejects(svc.submitReceipt(r.id, r.assignee, '500', 'NOK', ''), NotAllowed);
    await assert.rejects(svc.submitReceipt(r.id, r.assignee, '5e2', 'NOK', 'img'), NotAllowed);
  });
});

describe('handover', () => {
  it('unanswered offer goes to the next person', async () => {
    const r = await svc.reportEmpty(OSLO, 'x');
    clock.advance({ hours: 4, minutes: 1 });
    await svc.tick();
    const after = await R(r.id);
    assert.equal(after.state, State.OFFERED);
    assert.notEqual(after.assignee, r.assignee);
    assert.ok(after.excluded.includes(r.assignee));
  });

  it('declined offer goes to the next person', async () => {
    const r = await svc.reportEmpty(OSLO, 'x');
    const after = await svc.decline(r.id, r.assignee);
    assert.notEqual(after.assignee, r.assignee);
    assert.equal(after.state, State.OFFERED);
  });

  it('committed but not completed is handed to someone else', async () => {
    const r = await svc.reportEmpty(OSLO, 'x');
    const first = r.assignee;
    await svc.accept(r.id, first);
    clock.advance({ hours: 13 });
    await svc.tick();
    assert.ok(chat.to(first).some((t) => t.includes('Reminder')));
    clock.advance({ hours: 12 });                                  // past the 24h deadline
    await svc.tick();
    const after = await R(r.id);
    assert.equal(after.state, State.OFFERED);
    assert.notEqual(after.assignee, first);
    assert.equal(after.capMinor, null);                            // reservation released
    await assert.rejects(svc.submitReceipt(r.id, first, '500', 'NOK', 'img'), NotAllowed);
  });

  it('nobody available: escalates, then offers again when people return', async () => {
    await away(OSLO_IDS);
    const r = await svc.reportEmpty(OSLO, 'x');
    assert.equal(r.state, State.OPEN);
    assert.ok(chat.direct.some(([u]) => u === 'admin_oslo'));
    assert.ok(chat.channels.some(([c]) => c === OSLO));
    clock.advance({ days: 3, minutes: 1 });
    await svc.tick();
    assert.equal((await R(r.id)).state, State.OFFERED);
  });

  it('everyone declined: second round after the cooldown', async () => {
    const r = await svc.reportEmpty(OSLO, 'x');
    let cur = r;
    for (let i = 0; i < 3; i++) cur = await svc.decline(r.id, cur.assignee);
    assert.equal(cur.state, State.OPEN);
    clock.advance({ hours: 25 });
    await svc.tick();
    assert.equal((await R(r.id)).state, State.OFFERED);
  });

  it('open refill cannot be taken by an ineligible person', async () => {
    await away(OSLO_IDS);
    const r = await svc.reportEmpty(OSLO, 'x');
    await assert.rejects(svc.accept(r.id, 'b1'), NotAllowed);      // other office, not visiting
    await assert.rejects(svc.accept(r.id, 'o1'), NotAllowed);      // still away
  });
});

describe('fairness and visitors', () => {
  it('work is spread; people waiting for money go last', async () => {
    const picks = [];
    for (let i = 0; i < 3; i++) picks.push((await R(await buy(OSLO, '500'))).assignee);
    assert.deepEqual([...picks].sort(), ['o1', 'o2', 'o3']);       // nobody asked twice in a row
    clock.advance({ days: 3, minutes: 1 });
    await svc.tick();                                              // all reimbursed
    assert.equal((await svc.reportEmpty(OSLO, 'x')).assignee, picks[0]);   // asked longest ago
  });

  it('person with an unreimbursed claim is asked after others', async () => {
    const first = (await R(await buy(OSLO, '500'))).assignee;
    assert.notEqual((await svc.reportEmpty(OSLO, 'x')).assignee, first);
  });

  it('person on holiday is skipped', async () => {
    await svc.setAway('o1', new Date(clock.now().getTime() + 5 * 86400e3));
    assert.notEqual((await svc.reportEmpty(OSLO, 'x')).assignee, 'o1');
  });

  it('visitor is eligible where they are, not where they live', async () => {
    await svc.setVisiting('o1', BLR, new Date(clock.now().getTime() + 10 * 86400e3));
    await away(['b1', 'b2']);
    const r = await svc.reportEmpty(BLR, 'x');
    assert.equal(r.assignee, 'o1');
    assert.notEqual((await svc.reportEmpty(OSLO, 'x')).assignee, 'o1');
    await svc.accept(r.id, 'o1');
    await svc.submitReceipt(r.id, 'o1', '1500', 'INR', 'img');
    const claim = [...hr.claims.values()][0];
    assert.deepEqual([claim.employeeId, claim.currency, claim.amount], ['o1', 'INR', '1500.00']);
  });

  it('visitor is back home once the visit ends', async () => {
    await svc.setVisiting('o1', BLR, new Date(clock.now().getTime() + 7 * 86400e3));
    clock.advance({ days: 8 });
    await away(['o2', 'o3']);                                      // only o1 can be asked in Oslo
    assert.equal((await svc.reportEmpty(OSLO, 'x')).assignee, 'o1');
  });
});

describe('budget', () => {
  it('cap is limited by remaining budget', async () => {
    for (let i = 0; i < 5; i++) await buy(OSLO, '1100');           // 5500 of 6000 used
    const r = await svc.reportEmpty(OSLO, 'x');
    await svc.accept(r.id, r.assignee);
    assert.equal((await R(r.id)).capMinor, 50000);
  });

  it('committed cap is reserved, and released on withdraw', async () => {
    const r = await svc.reportEmpty(OSLO, 'x');
    await svc.accept(r.id, r.assignee);
    assert.equal((await svc.budgetStatus(OSLO, '2026-11')).remainingMinor, 600000 - 120000);
    await svc.decline(r.id, r.assignee);
    assert.equal((await svc.budgetStatus(OSLO, '2026-11')).remainingMinor, 600000);
  });

  it('over-cap receipt goes to review, is not sent to HR, and is sent once approved', async () => {
    for (let i = 0; i < 5; i++) await buy(OSLO, '1100');
    const before = hr.claims.size;
    const r = await svc.reportEmpty(OSLO, 'x');
    await svc.accept(r.id, r.assignee);                            // cap 500
    const after = await svc.submitReceipt(r.id, r.assignee, '600', 'NOK', 'img');
    assert.equal(after.state, State.NEEDS_REVIEW);
    assert.equal(hr.claims.size, before);
    assert.ok(chat.to('admin_oslo').some((t) => t.includes('Please approve')));
    assert.equal((await svc.resolveReview(r.id, true)).state, State.CLAIMED);
    assert.equal(hr.claims.size, before + 1);
  });

  it('exhausted budget blocks the refill and unblocks next month', async () => {
    for (let i = 0; i < 4; i++) await buy(OSLO, '1200');
    await buy(OSLO, '1000');                                       // 5800 used, 200 left < min 300
    const r = await svc.reportEmpty(OSLO, 'x');
    assert.equal(r.state, State.BLOCKED_BUDGET);
    assert.ok(chat.to('admin_oslo').some((t) => t.includes('blocked')));
    clock.set(Date.UTC(2026, 11, 1, 9, 0));
    await svc.tick();
    assert.equal((await R(r.id)).state, State.OFFERED);
  });

  it('budget eaten between offer and accept: commit fails and refill is blocked', async () => {
    const r = await svc.reportEmpty(OSLO, 'x');
    await store.tx((repo) => repo.insertRefill(blankRefill({
      office: OSLO, reportedBy: 'z', createdAt: clock.now(), state: State.REIMBURSED, assignee: 'o3',
      amountMinor: 590000, budgetMonth: '2026-11', purchasedAt: clock.now() })));
    await assert.rejects(svc.accept(r.id, r.assignee), BudgetExhausted);
    assert.equal((await R(r.id)).state, State.BLOCKED_BUDGET);     // and that change was kept
  });

  it('spend is attributed to the month of commit', async () => {
    clock.set(Date.UTC(2026, 10, 30, 20, 0));
    const r = await svc.reportEmpty(OSLO, 'x');
    await svc.accept(r.id, r.assignee);
    clock.advance({ hours: 5 });                                   // now 1 Dec
    await svc.submitReceipt(r.id, r.assignee, '800', 'NOK', 'img');
    assert.equal((await svc.monthlyReport(2026, 11)).offices[0].spentMinor, 80000);
    assert.equal((await svc.monthlyReport(2026, 12)).offices[0].spentMinor, 0);
  });
});

describe('HR integration', () => {
  it('HR down then up creates exactly one claim', async () => {
    hr.available = false;
    const id = await buy(OSLO, '700');
    assert.equal((await R(id)).state, State.RECEIPT_RECEIVED);
    await svc.tick();
    assert.equal(hr.claims.size, 0);
    hr.available = true;
    await svc.tick(); await svc.tick();
    assert.equal((await R(id)).state, State.CLAIMED);
    assert.equal(hr.claims.size, 1);
  });

  it('claim goes to reimbursed after approval', async () => {
    const id = await buy(OSLO, '700');
    assert.equal((await R(id)).state, State.CLAIMED);
    clock.advance({ days: 2 }); await svc.tick();
    assert.equal((await R(id)).state, State.CLAIMED);
    clock.advance({ days: 1 }); await svc.tick();
    assert.equal((await R(id)).state, State.REIMBURSED);
  });

  it('overdue claim alerts the admin once', async () => {
    hr.approvalDays = 30;
    await buy(OSLO, '700');
    clock.advance({ days: 11 });
    await svc.tick(); await svc.tick();
    assert.equal(chat.to('admin_oslo').filter((t) => t.includes('older than 10 days')).length, 1);
  });

  it('rejected claim stops counting toward the budget', async () => {
    const id = await buy(OSLO, '700');
    hr.rejected.add((await R(id)).claimId);
    await svc.tick();
    assert.equal((await R(id)).state, State.REJECTED);
    assert.equal((await svc.monthlyReport(2026, 11)).offices[0].spentMinor, 0);
  });

  it('a failed transaction rolls back and sends no chat messages', async () => {
    const sent = chat.direct.length;
    await assert.rejects(store.tx(async (repo) => {
      await repo.insertRefill(blankRefill({ office: OSLO, reportedBy: 'x', createdAt: clock.now() }));
      throw new Error('boom');
    }));
    assert.equal((await svc.listRefills({})).length, 0);
    assert.equal(chat.direct.length, sent);
  });
});

describe('reporting', () => {
  it('totals are correct across both currencies', async () => {
    await buy(OSLO, '1000', 'NOK', { chips: 3, nuts: 2 });
    await buy(OSLO, '500', 'NOK', { chips: 1 });
    await buy(BLR, '2000', 'INR', { chips: 4 });
    const open = await svc.reportEmpty(OSLO, 'x');                 // committed but not bought: not spend
    await svc.accept(open.id, open.assignee);
    const rep = await svc.monthlyReport(2026, 11);
    const [oslo, blr] = rep.offices;
    assert.deepEqual([oslo.spentMinor, oslo.currency, oslo.refills], [150000, 'NOK', 2]);
    assert.deepEqual([blr.spentMinor, blr.currency, blr.refills], [200000, 'INR', 1]);
    assert.equal(rep.totalMinor, 175000);                          // 1500 NOK + 2000 INR * 0.125
    assert.equal(oslo.utilisationPct, '25.0');
    assert.equal(blr.utilisationPct, '13.3');
    assert.deepEqual(oslo.topItems[0], ['chips', 4]);
    assert.equal(oslo.pendingClaims, 2);
  });

  it('report is published to the management channel', async () => {
    await buy(OSLO, '1000', 'NOK');
    await svc.publishMonthlyReport(2026, 11);
    const [channel, text] = chat.channels.at(-1);
    assert.equal(channel, 'management');
    assert.match(text, /Oslo/);
    assert.match(text, /Bengaluru/);
    assert.match(text, /Total: 1000\.00 NOK/);
  });

  it('money is exact (no float drift)', async () => {
    for (let i = 0; i < 3; i++) await buy(BLR, '333.33', 'INR');
    assert.equal((await svc.monthlyReport(2026, 11)).offices[1].spentMinor, 99999);
  });
});
