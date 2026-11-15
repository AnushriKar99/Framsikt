// Read-only status page: this month's budget per office and the refills in progress.
import { getService } from '../lib/container.js';
import { OFFICES } from '../lib/snackbot/config.js';
import { formatMoney } from '../lib/snackbot/money.js';

export const dynamic = 'force-dynamic';

export default async function Home() {
  const svc = await getService();
  const d = new Date();
  const month = `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
  const budgets = await Promise.all(OFFICES.map(async (o) => [o, await svc.budgetStatus(o.name, month)]));
  const active = (await svc.listRefills({})).filter((r) => !['REIMBURSED', 'REJECTED', 'CANCELLED'].includes(r.state));
  return (
    <main>
      <h1>Snack counter - {month}</h1>
      <h2>Budget</h2>
      <ul>
        {budgets.map(([o, b]) => (
          <li key={o.name}>{o.name}: {formatMoney(b.usedMinor)} / {formatMoney(b.budgetMinor)} {o.currency} used</li>
        ))}
      </ul>
      <h2>In progress</h2>
      {active.length === 0 ? <p>Nothing open.</p> : (
        <ul>
          {active.map((r) => (
            <li key={r.id}>#{r.id} {r.office}: {r.state}{r.assignee ? ` (${r.assignee})` : ''}</li>
          ))}
        </ul>
      )}
    </main>
  );
}
