// Simulated stand-ins: clock, chat tool, HR system, FX rates.
import { HRUnavailable } from './model.js';

export class FakeClock {
  constructor(start) { this._now = new Date(start); }
  now() { return new Date(this._now); }
  advance({ days = 0, hours = 0, minutes = 0 }) {
    this._now = new Date(this._now.getTime() + ((days * 24 + hours) * 60 + minutes) * 60000);
  }
  set(d) { this._now = new Date(d); }
}
export const systemClock = { now: () => new Date() };

export class FakeChat {
  constructor() { this.direct = []; this.channels = []; }   // [userId, text] / [channel, text]
  async send(userId, text) { this.direct.push([userId, text]); }
  async postChannel(channel, text) { this.channels.push([channel, text]); }
  to(userId) { return this.direct.filter(([u]) => u === userId).map(([, t]) => t); }
}

export class ConsoleChat {
  async send(userId, text) { console.log(`[chat -> ${userId}] ${text}`); }
  async postChannel(channel, text) { console.log(`[chat #${channel}] ${text}`); }
}

// Creates claims; approves them after `approvalDays` (1-10 in reality).
export class FakeHR {
  constructor(clock, approvalDays = 3) {
    Object.assign(this, { clock, approvalDays, available: true });
    this.claims = new Map(); this.byKey = new Map(); this.rejected = new Set();
  }
  async createClaim({ idempotencyKey, employeeId, amount, currency, description, receipt }) {
    if (!this.available) throw new HRUnavailable('HR is down');
    if (this.byKey.has(idempotencyKey)) return this.byKey.get(idempotencyKey);  // retry: no duplicate
    const id = `HR-${this.claims.size + 1}`;
    this.claims.set(id, { employeeId, amount, currency, description, receipt, created: this.clock.now() });
    this.byKey.set(idempotencyKey, id);
    return id;
  }
  async getStatus(claimId) {
    if (!this.available) throw new HRUnavailable('HR is down');
    if (this.rejected.has(claimId)) return 'REJECTED';
    const age = this.clock.now() - this.claims.get(claimId).created;
    return age >= this.approvalDays * 86400e3 ? 'APPROVED' : 'PENDING';
  }
}

export class FixedRates {
  constructor(rates) { this.rates = rates; }
  rate(from, to) { return this.rates[`${from}->${to}`]; }
}
