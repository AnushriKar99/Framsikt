# Snack counter automation (Next.js + Node + Postgres)

    npm test                 # 32 tests, Node's built-in runner, zero dependencies
    npm install && npm run dev      # runs on the in-memory store if DATABASE_URL is empty

With Postgres: set `DATABASE_URL`, then `npm run db:init -- --seed` (or `npm run db:seed`).

| Path | What |
|---|---|
| `lib/snackbot/service.js` | the lifecycle, volunteer choice, budget check, report |
| `lib/snackbot/model.js`, `money.js` | states, errors, config defaults; integer money helpers |
| `lib/snackbot/memoryStore.js`, `pgStore.js`, `schema.sql` | the two stores (same contract) |
| `lib/snackbot/fakes.js` | simulated clock, chat tool, HR system, FX rates |
| `app/api/chat` | chat-tool webhook (empty / accept / decline / receipt / away / visiting / review) |
| `app/api/cron/tick` | scheduler entry point, call every ~5 minutes |
| `app/api/reports/[month]` | monthly report (GET) and post-to-management (POST) |

Not verified in the sandbox this was written in (no network, no Postgres): `npm install`,
`next build`, and `pgStore.js` against a real database. The service logic is tested against
`MemoryStore`, which implements the same transaction and rollback contract.
