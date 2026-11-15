// Postgres store. Same contract as MemoryStore (see memoryStore.js).
// tx(): BEGIN + a global advisory lock, so all state changes are serialised across app
// instances. 35 volunteers means tiny load; a per-office lock would be the next step.
import pg from 'pg';

pg.types.setTypeParser(20, (v) => Number(v));   // bigint (ids, minor units) -> number

const LOCK_KEY = 727001;
const REFILL_FIELDS = [
  ['office', 'office'], ['reportedBy', 'reported_by'], ['createdAt', 'created_at'], ['state', 'state'],
  ['assignee', 'assignee'], ['deadline', 'deadline'], ['excluded', 'excluded'], ['capMinor', 'cap_minor'],
  ['budgetMonth', 'budget_month'], ['committedAt', 'committed_at'], ['amountMinor', 'amount_minor'],
  ['receipt', 'receipt'], ['items', 'items'], ['purchasedAt', 'purchased_at'], ['claimId', 'claim_id'],
  ['claimedAt', 'claimed_at'], ['reimbursedAt', 'reimbursed_at'], ['escalatedAt', 'escalated_at'],
  ['reminded', 'reminded'], ['overdueFlagged', 'overdue_flagged'],
];
const USER_FIELDS = [
  ['homeOffice', 'home_office'], ['payrollCurrency', 'payroll_currency'], ['isVolunteer', 'is_volunteer'],
  ['awayUntil', 'away_until'], ['visitingOffice', 'visiting_office'], ['visitingUntil', 'visiting_until'],
  ['lastAskedAt', 'last_asked_at'],
];
const fromRow = (fields) => (row) => row && ({ id: row.id, ...Object.fromEntries(fields.map(([f, c]) => [f, row[c]])) });
const refillFromRow = fromRow(REFILL_FIELDS);
const userFromRow = fromRow(USER_FIELDS);
const val = (f, v) => (f === 'items' ? JSON.stringify(v ?? {}) : f === 'excluded' ? (v ?? []) : (v ?? null));

export class PgStore {
  constructor(connectionString) { this.pool = new pg.Pool({ connectionString }); }

  async tx(fn) {
    const c = await this.pool.connect();
    try {
      await c.query('BEGIN');
      await c.query('SELECT pg_advisory_xact_lock($1)', [LOCK_KEY]);
      const out = await fn(repo(c));
      await c.query('COMMIT');
      return out;
    } catch (e) {
      await c.query('ROLLBACK').catch(() => {});
      throw e;
    } finally { c.release(); }
  }
  close() { return this.pool.end(); }
}

const repo = (c) => ({
  async users() { return (await c.query('SELECT * FROM users ORDER BY id')).rows.map(userFromRow); },
  async user(id) { return userFromRow((await c.query('SELECT * FROM users WHERE id=$1', [id])).rows[0]); },
  async updateUser(id, patch) {
    const sets = USER_FIELDS.filter(([f]) => f in patch);
    if (!sets.length) return;
    await c.query(`UPDATE users SET ${sets.map(([, col], i) => `${col}=$${i + 1}`).join(', ')} WHERE id=$${sets.length + 1}`,
      [...sets.map(([f]) => patch[f] ?? null), id]);
  },
  touchAsked: (id, at) => c.query('UPDATE users SET last_asked_at=$1 WHERE id=$2', [at, id]),

  async refill(id) { return refillFromRow((await c.query('SELECT * FROM refills WHERE id=$1', [id])).rows[0]) ?? null; },
  async refills(f = {}) {
    const where = [], p = [];
    if (f.office) { p.push(f.office); where.push(`office=$${p.length}`); }
    if (f.states) { p.push(f.states); where.push(`state = ANY($${p.length})`); }
    if (f.budgetMonth) { p.push(f.budgetMonth); where.push(`budget_month=$${p.length}`); }
    const sql = `SELECT * FROM refills ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY id`;
    return (await c.query(sql, p)).rows.map(refillFromRow);
  },
  async insertRefill(r) {
    const cols = REFILL_FIELDS.map(([, col]) => col);
    const res = await c.query(
      `INSERT INTO refills (${cols.join(',')}) VALUES (${cols.map((_, i) => `$${i + 1}`).join(',')}) RETURNING *`,
      REFILL_FIELDS.map(([f]) => val(f, r[f])));
    return refillFromRow(res.rows[0]);
  },
  async saveRefill(r) {
    await c.query(
      `UPDATE refills SET ${REFILL_FIELDS.map(([, col], i) => `${col}=$${i + 1}`).join(', ')} WHERE id=$${REFILL_FIELDS.length + 1}`,
      [...REFILL_FIELDS.map(([f]) => val(f, r[f])), r.id]);
  },
  event: (refillId, at, text) => c.query('INSERT INTO refill_events (refill_id, at, text) VALUES ($1,$2,$3)', [refillId, at, text]),
  async events(refillId) {
    return (await c.query('SELECT at, text FROM refill_events WHERE refill_id=$1 ORDER BY id', [refillId])).rows;
  },
});
