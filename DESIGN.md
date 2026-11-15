# Snack Counter Automation – Design

Oslo (about 15 volunteers) and Bengaluru (about 20 volunteers). Code and tests are in this repository (Next.js, Node and Postgres); 32 tests pass with `npm test`.

## What "automate" means here

The goal is not to remove people from the process. People still buy and refill the box, because a robot cannot do that. What gets automated is the **coordination**: knowing the box is empty, picking exactly one person, chasing them, handing over if they go quiet, filing the claim, tracking the money and reporting. A chat bot drives it, since everyone already uses the chat tool and has a company login. No new app and no new login.

## Questions I would have asked, and the assumptions I made

- **Who reports "empty"?** Assumed anyone, with one button or command in chat. Sensors and a weekly rota were considered and rejected (see the end).
- **Does HR give us a claim ID, a status lookup and idempotent create?** The brief only says we can create claims. I assumed a claim ID and a status lookup, and that the idempotency key is honoured. If HR has no status lookup, "reimbursed" becomes a timer plus the volunteer confirming in chat. If there is no idempotency, the refill number in the claim description is the duplicate check.
- **Is the budget a hard stop?** Assumed soft per refill and hard per month: each purchase gets a pre-approved cap, and anything above it goes to the office admin.
- **Which exchange rate for the management report?** Assumed one configured rate per month, shown in the report, with both local totals alongside. The total is in NOK. This is one line to change.
- **Is an away or holiday status available from a calendar?** Assumed volunteers set it in chat. Calendar integration is not built.

## How a refill moves from "empty" to "reimbursed"

1. **Empty reported.** Duplicate reports return the existing refill, so there is never more than one open refill per office.
2. **Budget check.** If the month's remaining budget is below the minimum purchase, the refill is `BLOCKED_BUDGET` and the office admin is told. It restarts by itself in the next month.
3. **Offered.** The bot asks one volunteer, who has 4 hours to answer. Only that person can accept. Declines and timeouts move to the next person.
4. **Committed.** On accept, a spend cap (the lower of the typical maximum and the remaining budget) is reserved against the month's budget, and a 24-hour purchase deadline starts. A reminder goes out at the halfway point, and the channel is told someone is on it, so nobody else buys.
5. **Handover.** If the deadline passes, the person is excluded for this refill, the reservation is released, and the next volunteer is asked. If nobody is available, the refill becomes `OPEN`, the channel and admin are told, and any eligible person can self-claim. After 24 hours the exclusions reset and everyone is asked again.
6. **Receipt.** The volunteer sends the amount, the receipt image and optionally the snacks bought. A receipt above the cap goes to `NEEDS_REVIEW` and is not sent to HR until the admin approves it. Otherwise the claim is created in HR with the employee ID, amount, currency, description and image.
7. **Reimbursed.** The bot polls HR. On approval the volunteer is told. On rejection the admin is told. A claim older than 10 days alerts the admin once.

The box counts as refilled as soon as the receipt arrives, so a new "empty" report is allowed while HR is still approving.

## Parts and the data each keeps

- **Chat adapter.** Turns buttons and commands into calls and sends messages. It keeps nothing.
- **Refill service** (the core, `lib/snackbot/service.js`). It owns the refill record: office, state, assignee, deadline, cap, budget month, amount, receipt reference, snack items, HR claim ID, the list of people excluded for this refill, and an audit trail of events.
- **Directory.** One record per person: employee ID, home office, payroll currency, volunteer flag, away-until and visiting (office and end date). The employee ID is the HR ID, so no mapping is needed.
- **HR adapter.** Creates claims and reads their status. It keeps nothing, apart from retrying.
- **Scheduler.** Calls `tick()` every few minutes. All time-based behaviour lives there: timeouts, reminders, retries and polling.
- **Reporting.** `monthlyReport` reads refills and posts one message to management on the first of the month.

Refill records live in Postgres; tests and local development use an in-memory store with the same transaction contract. Next.js hosts the chat webhook, the five-minute tick endpoint and the report endpoint. Chat messages are sent only after a transaction commits, and HR is called outside the lock with an idempotency key, so a slow HR never blocks the office.

## How the listed problems are prevented

- **Box empty for days because everyone assumes someone else will refill it.** One named person is always responsible, with a deadline, a reminder and an automatic handover. When nobody is available, an escalation goes to the channel and the admin.
- **Two people buy on the same day.** There is one open refill per office. Only the person asked can accept, and acceptance is serialised: with simultaneous attempts exactly one wins. In Postgres every change runs in a transaction holding an advisory lock, and a partial unique index refuses a second open refill per office. The channel is told who is on it.
- **A few people do most of the refills.** The next volunteer is chosen by: first, fewest claims still unpaid; then, fewest refills in the last 90 days; then, longest since last asked. Someone waiting for money is asked last.
- **People wait weeks for their money.** Claims are filed within seconds of the receipt, retried if HR is down, and polled. Nothing is left waiting on the volunteer to remember to file it. The pending-claims count appears in the report, and claims older than 10 days alert the admin.
- **Nobody knows monthly spend or which snacks get eaten.** Every purchase is a record. The report shows spend per office against budget, claims still unpaid, a combined total in NOK, and the top snacks by quantity.

## Money, currencies and visitors

- Amounts are integer minor units (øre, paise), never floats. Budgets and per-office totals stay in the office's own currency (NOK, INR). Only the management total is converted, with the rate shown.
- A receipt must be in the office currency. HR pays the volunteer in their payroll currency, so we do not convert for them.
- A visitor is eligible in the office where they currently are, until their visit ends, and not in their home office meanwhile. They buy in the local currency and file the claim in that currency under their own employee ID.
- Spend is attributed to the month in which the refill was committed. This keeps reservation and spend in one budget month, even if the receipt arrives on the 1st.

## Trade-offs and what I deliberately did not build

- **One person asked at a time, not a broadcast.** Slower than "first to claim", but it avoids pile-ups and makes fairness possible. The cost is up to 4 hours per unanswered offer, which is configurable.
- **Simple deadlines, not working-hours aware.** Hybrid and holiday availability is handled by the away status, not by a calendar, so an offer sent at 17:55 still has a 4-hour clock. Budget months are UTC calendar months, so a purchase just after local midnight in Oslo can land in the wrong month by an hour or two.
- **Hard cap per purchase, human review above it.** This keeps the budget honest at the cost of occasional admin work.
- **Not built:** receipt scanning or OCR and price checking; automatic detection of an empty box with sensors; calendar integration; ordering snacks online or a shared company card; a web dashboard beyond a read-only status page; punishing volunteers who often time out; real chat and HR integrations; admin tools to change budgets, which are configuration for now.
- **Written but not run:** the Postgres store, the schema and the Next.js routes could not be run in the environment where I wrote them (no database, no network). The service logic is tested against the in-memory store, which follows the same transaction and rollback contract.

## What I would do first with another week

Build the real chat and HR adapters behind the existing interfaces, run the Postgres store against a real database (it is written but not yet exercised), add the calendar away signal, and replace the fixed exchange rate with a monthly rate from finance.
