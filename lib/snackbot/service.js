/**
 * Snack counter automation - core service.
 *
 *   empty reported -> OFFERED -> COMMITTED -> RECEIPT_RECEIVED -> CLAIMED -> REIMBURSED
 *   side exits: OPEN (nobody available), BLOCKED_BUDGET, NEEDS_REVIEW, REJECTED
 *
 * Concurrency: every state change runs inside store.tx(), which is serialised (global
 * advisory lock in Postgres, a queue in memory). Two people accepting at once => one wins.
 *
 * Side effects: chat messages are queued in the tx and sent only after it COMMITS (a rolled
 * back tx never talks to anyone). HR calls happen OUTSIDE the lock, guarded by an
 * idempotency key, so a slow HR never blocks the office.
 */
import {
  BudgetExhausted, DEFAULT_CONFIG, FULFILMENT, HRUnavailable, NotAllowed, OUTSTANDING, SPENT,
  State, blankRefill,
} from './model.js';
import { convertMinor, formatMoney, parseMoney } from './money.js';

const ym = (d) => `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
const at = (d) => `${d.toUTCString().slice(0, 3)} ${d.toISOString().slice(11, 16)} UTC`;
const plus = (d, ms) => new Date(d.getTime() + ms);

export function createService({ store, chat, hr, clock, rates, offices, config = {} }) {
  const cfg = { ...DEFAULT_CONFIG, ...config };
  const office = Object.fromEntries(offices.map((o) => [o.name, o]));
  const now = () => clock.now();

  // ---- transaction wrapper with an outbox for chat messages -------------------------
  async function run(fn) {
    const { value, out } = await store.tx(async (repo) => {
      const out = [];
      const ctx = {
        repo, out,
        dm: (user, text) => out.push(() => chat.send(user, text)),
        channel: (ch, text) => out.push(() => chat.postChannel(ch, text)),
        save: (r) => repo.saveRefill(r),
        log: (r, text) => repo.event(r.id ?? r, now(), text),
      };
      return { value: await fn(ctx), out };
    });
    for (const send of out) {                       // after commit; best effort
      try { await send(); } catch (e) { console.error('chat send failed', e); }
    }
    return value;
  }
  const fail = (e) => { throw e; };               // errors are returned from tx, thrown after commit

  // ---- budget -------------------------------------------------------------------------
  async function usage(ctx, o, month) {
    let total = 0;
    for (const r of await ctx.repo.refills({ office: o.name, budgetMonth: month })) {
      if (r.state === State.COMMITTED) total += r.capMinor;       // reserved
      else if (SPENT.has(r.state)) total += r.amountMinor;        // spent
    }
    return total;
  }
  const remaining = async (ctx, o, month) => o.monthlyBudgetMinor - (await usage(ctx, o, month));

  // ---- choosing who buys --------------------------------------------------------------
  const officeAt = (u) => (u.visitingOffice && now() < u.visitingUntil ? u.visitingOffice : u.homeOffice);
  const isEligible = (u, officeName, excluded) =>
    u.isVolunteer && !excluded.includes(u.id) && (!u.awayUntil || now() >= u.awayUntil)
    && officeAt(u) === officeName;

  /** Lowest wins: nobody out of pocket first, then fewest recent refills, then asked longest ago. */
  function rankKey(u, all) {
    const mine = all.filter((r) => r.assignee === u.id);
    const outstanding = mine.filter((r) => OUTSTANDING.has(r.state)).length;
    const recent = mine.filter((r) => SPENT.has(r.state) && r.purchasedAt
      && now() - r.purchasedAt <= cfg.fairnessWindowMs).length;
    return [outstanding, recent, u.lastAskedAt ? u.lastAskedAt.getTime() : 0, u.id];
  }
  const cmp = (a, b) => { for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return a[i] < b[i] ? -1 : 1; return 0; };

  function budgetBlocked(ctx, r) {
    const o = office[r.office];
    ctx.dm(o.adminId, `Refill #${r.id} blocked: ${r.office} budget for this month is used up.`);
    ctx.channel(r.office, "Snack box is empty but this month's budget is used up; the office admin has been told.");
  }

  /** Budget check, then ask the best-ranked eligible volunteer (or escalate). Saves r. */
  async function start(ctx, r) {
    const o = office[r.office], t = now();
    if (await remaining(ctx, o, ym(t)) < o.minPurchaseMinor) {
      if (r.state !== State.BLOCKED_BUDGET) {
        r.state = State.BLOCKED_BUDGET; r.assignee = null;
        await ctx.log(r, 'blocked: budget exhausted'); budgetBlocked(ctx, r);
      }
      return ctx.save(r);
    }
    const all = await ctx.repo.refills({});
    const cands = (await ctx.repo.users()).filter((u) => isEligible(u, r.office, r.excluded));
    if (!cands.length) {
      Object.assign(r, { state: State.OPEN, assignee: null, deadline: null });
      if (!r.escalatedAt) {
        r.escalatedAt = t;
        await ctx.log(r, 'escalated: nobody available');
        ctx.channel(r.office, `Snack box is empty (refill #${r.id}) and nobody has picked it up - can anyone take it?`);
        ctx.dm(o.adminId, `Refill #${r.id} in ${r.office} has no available volunteer.`);
      }
      return ctx.save(r);
    }
    const pick = cands.map((u) => [rankKey(u, all), u]).sort((a, b) => cmp(a[0], b[0]))[0][1];
    Object.assign(r, { state: State.OFFERED, assignee: pick.id, deadline: plus(t, cfg.offerTimeoutMs), escalatedAt: null });
    await ctx.repo.touchAsked(pick.id, t);
    await ctx.log(r, `offered to ${pick.id}`);
    ctx.dm(pick.id, `The ${r.office} snack box is empty. Can you refill it? [Accept] [Decline] - please answer by ${at(r.deadline)}.`);
    return ctx.save(r);
  }

  async function release(ctx, r, userId) {
    r.excluded = [...r.excluded, userId];
    Object.assign(r, { assignee: null, deadline: null, capMinor: null, budgetMonth: null, committedAt: null, reminded: false });
    await start(ctx, r);
  }

  // ---- HR (outside the lock) ----------------------------------------------------------
  async function tryClaim(id) {
    const r = await run(async (ctx) => {
      const x = await ctx.repo.refill(id);
      return x && x.state === State.RECEIPT_RECEIVED ? x : null;
    });
    if (!r) return;
    const o = office[r.office];
    let claimId;
    try {
      claimId = await hr.createClaim({
        idempotencyKey: `snack-refill-${r.id}`, employeeId: r.assignee, amount: formatMoney(r.amountMinor),
        currency: o.currency, description: `Snack refill #${r.id} (${r.office})`, receipt: r.receipt,
      });
    } catch (e) {
      if (!(e instanceof HRUnavailable)) throw e;
      return run((ctx) => ctx.log(r, 'HR unavailable, will retry'));
    }
    await run(async (ctx) => {
      const x = await ctx.repo.refill(id);
      if (x.state !== State.RECEIPT_RECEIVED) return;
      Object.assign(x, { claimId, state: State.CLAIMED, claimedAt: now() });
      await ctx.save(x); await ctx.log(x, `claim ${claimId} created`);
      ctx.dm(x.assignee, `Reimbursement claim sent to HR (${formatMoney(x.amountMinor)} ${o.currency}). Approval usually takes 1-10 days.`);
    });
  }

  async function pollClaim(id) {
    const r = await run(async (ctx) => ctx.repo.refill(id));
    let status;
    try { status = await hr.getStatus(r.claimId); }
    catch (e) { if (e instanceof HRUnavailable) return; throw e; }
    await run(async (ctx) => {
      const x = await ctx.repo.refill(id);
      if (x.state !== State.CLAIMED) return;
      const admin = office[x.office].adminId;
      if (status === 'APPROVED') {
        Object.assign(x, { state: State.REIMBURSED, reimbursedAt: now() });
        await ctx.log(x, 'reimbursed');
        ctx.dm(x.assignee, `HR approved refill #${x.id} - you will be paid in your payroll currency.`);
      } else if (status === 'REJECTED') {
        x.state = State.REJECTED; await ctx.log(x, 'HR rejected claim');
        ctx.dm(x.assignee, `HR rejected the claim for refill #${x.id}.`);
        ctx.dm(admin, `HR rejected claim ${x.claimId} (refill #${x.id}).`);
      } else if (!x.overdueFlagged && now() - x.claimedAt > cfg.claimOverdueMs) {
        x.overdueFlagged = true; await ctx.log(x, 'claim overdue');
        ctx.dm(admin, `Claim ${x.claimId} (refill #${x.id}) is older than 10 days - please chase HR.`);
      }
      await ctx.save(x);
    });
  }

  // ---- public API ---------------------------------------------------------------------
  const svc = {
    /** Anyone can report an empty box. Duplicate reports return the existing refill. */
    reportEmpty(officeName, reporter) {
      if (!office[officeName]) throw new NotAllowed('unknown office');
      return run(async (ctx) => {
        const [existing] = await ctx.repo.refills({ office: officeName, states: [...FULFILMENT] });
        if (existing) { await ctx.log(existing, `duplicate empty report by ${reporter}`); return existing; }
        const r = await ctx.repo.insertRefill(blankRefill({
          office: officeName, reportedBy: reporter, createdAt: now(), state: State.OPEN }));
        await ctx.log(r, `reported empty by ${reporter}`);
        await start(ctx, r);
        return r;
      });
    },

    /** Volunteer commits: the person asked, or (once OPEN) one eligible self-volunteer. */
    async accept(refillId, userId) {
      const res = await run(async (ctx) => {
        const r = await ctx.repo.refill(refillId);
        const u = await ctx.repo.user(userId);
        if (!r) return { err: new NotAllowed('unknown refill') };
        if (!u) return { err: new NotAllowed('unknown user') };
        if (r.state === State.OFFERED) {
          if (r.assignee !== userId) return { err: new NotAllowed(`offer is currently with ${r.assignee}`) };
        } else if (r.state === State.OPEN) {
          if (!isEligible(u, r.office, [])) return { err: new NotAllowed('you are not eligible to take this refill right now') };
        } else if (r.state === State.COMMITTED) {
          return { err: new NotAllowed(`already taken by ${r.assignee}`) };
        } else return { err: new NotAllowed(`refill is ${r.state}`) };

        const o = office[r.office], t = now(), month = ym(t);
        const cap = Math.min(o.maxPurchaseMinor, await remaining(ctx, o, month));
        if (cap < o.minPurchaseMinor) {
          r.state = State.BLOCKED_BUDGET; r.assignee = null;
          await ctx.save(r); await ctx.log(r, 'budget exhausted at commit'); budgetBlocked(ctx, r);
          return { err: new BudgetExhausted('not enough budget left this month') };
        }
        Object.assign(r, { state: State.COMMITTED, assignee: userId, committedAt: t,
          deadline: plus(t, cfg.purchaseDeadlineMs), capMinor: cap, budgetMonth: month });
        await ctx.save(r); await ctx.log(r, `committed by ${userId}, cap ${formatMoney(cap)} ${o.currency}`);
        ctx.dm(userId, `Thanks! Refill #${r.id}: spend up to ${formatMoney(cap)} ${o.currency}, buy by ${at(r.deadline)}, then send the receipt here.`);
        ctx.channel(r.office, `${userId} is refilling the snack box - no need to buy.`);
        return { refill: r };
      });
      return res.err ? fail(res.err) : res.refill;
    },

    /** Decline an offer, or withdraw after committing. Hands over to the next person. */
    async decline(refillId, userId) {
      const res = await run(async (ctx) => {
        const r = await ctx.repo.refill(refillId);
        if (!r || r.assignee !== userId || ![State.OFFERED, State.COMMITTED].includes(r.state))
          return { err: new NotAllowed('you do not hold this refill') };
        await ctx.log(r, `${userId} declined/withdrew`);
        await release(ctx, r, userId);
        return { refill: r };
      });
      return res.err ? fail(res.err) : res.refill;
    },

    async submitReceipt(refillId, userId, amount, currency, receipt, items = {}) {
      const res = await run(async (ctx) => {
        const r = await ctx.repo.refill(refillId);
        if (!r || r.state !== State.COMMITTED || r.assignee !== userId)
          return { err: new NotAllowed('you have not committed to this refill') };
        const o = office[r.office];
        if (currency !== o.currency) return { err: new NotAllowed(`receipt must be in ${o.currency}`) };
        let minor;
        try { minor = parseMoney(amount); } catch (e) { return { err: e }; }
        if (minor <= 0 || !receipt) return { err: new NotAllowed('need a positive amount and a receipt image') };
        Object.assign(r, { amountMinor: minor, receipt, items: { ...items }, purchasedAt: now() });
        if (minor > r.capMinor) {
          r.state = State.NEEDS_REVIEW;
          await ctx.save(r); await ctx.log(r, `receipt ${formatMoney(minor)} above cap ${formatMoney(r.capMinor)}`);
          ctx.dm(userId, `${formatMoney(minor)} ${currency} is above the ${formatMoney(r.capMinor)} pre-approved; ${r.office} admin will review it.`);
          ctx.dm(o.adminId, `Refill #${r.id}: ${userId} spent ${formatMoney(minor)} ${currency}, cap was ${formatMoney(r.capMinor)}. Please approve or reject.`);
        } else {
          r.state = State.RECEIPT_RECEIVED;
          await ctx.save(r); await ctx.log(r, `receipt ${formatMoney(minor)} ${currency}`);
          ctx.channel(r.office, 'Snack box refilled - thank you!');
        }
        return { refill: r };
      });
      if (res.err) throw res.err;
      if (res.refill.state === State.RECEIPT_RECEIVED) await tryClaim(refillId);
      return svc.getRefill(refillId);
    },

    async resolveReview(refillId, approve) {
      const res = await run(async (ctx) => {
        const r = await ctx.repo.refill(refillId);
        if (!r || r.state !== State.NEEDS_REVIEW) return { err: new NotAllowed('nothing to review') };
        if (approve) { r.state = State.RECEIPT_RECEIVED; await ctx.log(r, 'over-cap receipt approved by admin'); }
        else {
          r.state = State.REJECTED; await ctx.log(r, 'over-cap receipt rejected by admin');
          ctx.dm(r.assignee, `Refill #${r.id} was not approved; please talk to the office admin.`);
        }
        await ctx.save(r);
        return { refill: r };
      });
      if (res.err) throw res.err;
      if (approve) await tryClaim(refillId);
      return svc.getRefill(refillId);
    },

    /** Run every few minutes. Everything time-based happens here, nowhere else. */
    async tick() {
      await run(async (ctx) => {
        const active = await ctx.repo.refills({ states: [State.OFFERED, State.COMMITTED, State.OPEN, State.BLOCKED_BUDGET] });
        for (const r of active) {
          const t = now();
          if (r.state === State.OFFERED && t >= r.deadline) {
            await ctx.log(r, `offer to ${r.assignee} timed out`);
            ctx.dm(r.assignee, `Refill #${r.id} offer expired - passed to someone else.`);
            await release(ctx, r, r.assignee);
          } else if (r.state === State.COMMITTED) {
            if (t >= r.deadline) {
              await ctx.log(r, `${r.assignee} did not complete in time`);
              ctx.dm(r.assignee, `Refill #${r.id} is being handed to someone else.`);
              await release(ctx, r, r.assignee);
            } else if (!r.reminded && t >= plus(r.committedAt, (r.deadline - r.committedAt) / 2)) {
              r.reminded = true; await ctx.save(r);
              ctx.dm(r.assignee, `Reminder: refill #${r.id} is due by ${at(r.deadline)}. Can't make it? Tap 'hand over'.`);
            }
          } else if (r.state === State.OPEN) {
            if (r.escalatedAt && t - r.escalatedAt >= cfg.escalationRetryMs) {
              r.excluded = []; r.escalatedAt = t;            // second round: ask everyone again
            }
            await start(ctx, r);
          } else if (r.state === State.BLOCKED_BUDGET) {
            await start(ctx, r);                             // e.g. new month -> fresh budget
          }
        }
      });
      const pending = await run((ctx) => ctx.repo.refills({ states: [State.RECEIPT_RECEIVED, State.CLAIMED] }));
      for (const r of pending) {
        if (r.state === State.RECEIPT_RECEIVED) await tryClaim(r.id); else await pollClaim(r.id);
      }
    },

    // ---- people ----
    setAway: (userId, until) => run((ctx) => ctx.repo.updateUser(userId, { awayUntil: until })),
    setVisiting: (userId, officeName, until) =>
      run((ctx) => ctx.repo.updateUser(userId, { visitingOffice: officeName, visitingUntil: until })),

    // ---- reads ----
    getRefill: (id) => run((ctx) => ctx.repo.refill(id)),
    listRefills: (filter) => run((ctx) => ctx.repo.refills(filter)),
    budgetStatus: (officeName, month) => run(async (ctx) => {
      const o = office[officeName], used = await usage(ctx, o, month);
      return { budgetMinor: o.monthlyBudgetMinor, usedMinor: used, remainingMinor: o.monthlyBudgetMinor - used };
    }),

    async monthlyReport(year, month) {
      const key = `${year}-${String(month).padStart(2, '0')}`;
      return run(async (ctx) => {
        const rows = [], usedRates = {};
        let total = 0;
        for (const o of offices) {
          const rs = (await ctx.repo.refills({ office: o.name, budgetMonth: key })).filter((r) => SPENT.has(r.state));
          const spentMinor = rs.reduce((s, r) => s + r.amountMinor, 0);
          const counts = {};
          for (const r of rs) for (const [n, q] of Object.entries(r.items)) counts[n] = (counts[n] ?? 0) + q;
          const topItems = Object.entries(counts).sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1)).slice(0, 5);
          rows.push({ office: o.name, currency: o.currency, budgetMinor: o.monthlyBudgetMinor, spentMinor,
            refills: rs.length, pendingClaims: rs.filter((r) => OUTSTANDING.has(r.state)).length, topItems,
            utilisationPct: ((spentMinor * 100) / o.monthlyBudgetMinor).toFixed(1) });
          if (o.currency === cfg.reportingCurrency) total += spentMinor;
          else {
            const rate = rates.rate(o.currency, cfg.reportingCurrency);
            usedRates[`${o.currency}->${cfg.reportingCurrency}`] = rate;
            total += convertMinor(spentMinor, rate);
          }
        }
        return { year, month, offices: rows, reportingCurrency: cfg.reportingCurrency, totalMinor: total, rates: usedRates };
      });
    },

    async publishMonthlyReport(year, month) {
      const rep = await svc.monthlyReport(year, month);
      const lines = [`Snack spend ${year}-${String(month).padStart(2, '0')}`];
      for (const o of rep.offices) {
        lines.push(`- ${o.office}: ${formatMoney(o.spentMinor)} / ${formatMoney(o.budgetMinor)} ${o.currency} (${o.utilisationPct}%), ` +
          `${o.refills} refills, ${o.pendingClaims} claims not yet reimbursed`);
      }
      lines.push(`Total: ${formatMoney(rep.totalMinor)} ${rep.reportingCurrency} (rates: ${JSON.stringify(rep.rates)})`);
      await chat.postChannel('management', lines.join('\n'));
      return rep;
    },
  };
  return svc;
}
