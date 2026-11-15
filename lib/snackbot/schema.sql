-- Snack counter schema (Postgres 14+). Money is BIGINT minor units (øre / paise).
CREATE TABLE IF NOT EXISTS users (
  id              text PRIMARY KEY,              -- same as the HR employee id
  home_office     text NOT NULL,
  payroll_currency text NOT NULL,
  is_volunteer    boolean NOT NULL DEFAULT true,
  away_until      timestamptz,                   -- holiday / "I'm out"
  visiting_office text,
  visiting_until  timestamptz,
  last_asked_at   timestamptz
);

CREATE TABLE IF NOT EXISTS refills (
  id              bigserial PRIMARY KEY,
  office          text NOT NULL,
  reported_by     text NOT NULL,
  created_at      timestamptz NOT NULL,
  state           text NOT NULL CHECK (state IN ('BLOCKED_BUDGET','OFFERED','OPEN','COMMITTED',
                    'RECEIPT_RECEIVED','CLAIMED','NEEDS_REVIEW','REIMBURSED','REJECTED','CANCELLED')),
  assignee        text REFERENCES users(id),
  deadline        timestamptz,
  excluded        text[] NOT NULL DEFAULT '{}',  -- declined / timed out / abandoned for this refill
  cap_minor       bigint,                        -- pre-approved max, reserved in the budget
  budget_month    text,                          -- 'YYYY-MM', fixed at commit
  committed_at    timestamptz,
  amount_minor    bigint,
  receipt         text,                          -- reference to the receipt image
  items           jsonb NOT NULL DEFAULT '{}',   -- snack name -> quantity
  purchased_at    timestamptz,
  claim_id        text,
  claimed_at      timestamptz,
  reimbursed_at   timestamptz,
  escalated_at    timestamptz,
  reminded        boolean NOT NULL DEFAULT false,
  overdue_flagged boolean NOT NULL DEFAULT false
);

-- Defence in depth: the database itself refuses a second "box is empty" refill per office.
CREATE UNIQUE INDEX IF NOT EXISTS one_fulfilment_refill_per_office
  ON refills (office) WHERE state IN ('BLOCKED_BUDGET','OFFERED','OPEN','COMMITTED');
CREATE INDEX IF NOT EXISTS refills_state_idx ON refills (state);
CREATE INDEX IF NOT EXISTS refills_budget_idx ON refills (office, budget_month);

-- Audit trail: who did what, when.
CREATE TABLE IF NOT EXISTS refill_events (
  id        bigserial PRIMARY KEY,
  refill_id bigint NOT NULL REFERENCES refills(id),
  at        timestamptz NOT NULL,
  text      text NOT NULL
);
CREATE INDEX IF NOT EXISTS refill_events_refill_idx ON refill_events (refill_id);
