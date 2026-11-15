// In-memory store with the same contract as the Postgres store:
//  - tx() calls are serialised (like the advisory lock) and rolled back if fn throws.
//  - repo methods return copies; nothing changes until saveRefill/updateUser is called.
import { blankRefill } from './model.js';

export class MemoryStore {
  constructor({ users = [] } = {}) {
    this.d = { users: new Map(users.map((u) => [u.id, normUser(u)])), refills: new Map(),
               events: [], nextId: 1 };
    this._q = Promise.resolve();
  }

  tx(fn) {
    const run = this._q.then(async () => {
      const snapshot = structuredClone(this.d);
      try { return await fn(this._repo()); }
      catch (e) { this.d = snapshot; throw e; }          // rollback
    });
    this._q = run.catch(() => {});
    return run;
  }

  _repo() {
    const s = this;
    return {
      async users() { return [...s.d.users.values()].map((u) => ({ ...u })); },
      async user(id) { const u = s.d.users.get(id); return u ? { ...u } : null; },
      async updateUser(id, patch) { Object.assign(s.d.users.get(id), patch); },
      async touchAsked(id, at) { s.d.users.get(id).lastAskedAt = at; },
      async refill(id) { const r = s.d.refills.get(id); return r ? structuredClone(r) : null; },
      async refills(f = {}) {
        return [...s.d.refills.values()]
          .filter((r) => (!f.office || r.office === f.office)
            && (!f.states || f.states.includes(r.state))
            && (!f.budgetMonth || r.budgetMonth === f.budgetMonth))
          .map((r) => structuredClone(r));
      },
      async insertRefill(r) {
        const row = blankRefill({ ...structuredClone(r), id: s.d.nextId++ });
        s.d.refills.set(row.id, row);
        return structuredClone(row);
      },
      async saveRefill(r) { s.d.refills.set(r.id, structuredClone(r)); },
      async event(refillId, at, text) { s.d.events.push({ refillId, at, text }); },
      async events(refillId) { return s.d.events.filter((e) => e.refillId === refillId); },
    };
  }
}

export function normUser(u) {
  return { isVolunteer: true, awayUntil: null, visitingOffice: null, visitingUntil: null,
           lastAskedAt: null, ...u };
}
