// node scripts/init-db.js [--seed]   (needs DATABASE_URL and `npm install`)
import { readFileSync } from 'node:fs';
import pg from 'pg';
import { DEMO_USERS } from '../lib/snackbot/config.js';

const client = new pg.Client({ connectionString: process.env.DATABASE_URL });
await client.connect();
await client.query(readFileSync(new URL('../lib/snackbot/schema.sql', import.meta.url), 'utf8'));
if (process.argv.includes('--seed')) {
  for (const u of DEMO_USERS) {
    await client.query(
      'INSERT INTO users (id, home_office, payroll_currency) VALUES ($1,$2,$3) ON CONFLICT DO NOTHING',
      [u.id, u.homeOffice, u.payrollCurrency]);
  }
}
await client.end();
console.log('schema ready');
