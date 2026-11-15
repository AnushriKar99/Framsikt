export class RefillError extends Error {}
export class NotAllowed extends RefillError {}      // wrong person, too late, someone else got it
export class BudgetExhausted extends RefillError {}
export class HRUnavailable extends Error {}         // thrown by an HR adapter when HR is down

export const State = Object.freeze({
  BLOCKED_BUDGET: 'BLOCKED_BUDGET',     // month's budget can't cover a minimum purchase
  OFFERED: 'OFFERED',                   // one volunteer has been asked
  OPEN: 'OPEN',                         // nobody to ask; any eligible person may self-claim
  COMMITTED: 'COMMITTED',               // accepted; must buy before the deadline
  RECEIPT_RECEIVED: 'RECEIPT_RECEIVED', // bought; HR claim not yet accepted by HR
  CLAIMED: 'CLAIMED',                   // HR claim exists, waiting for approval
  NEEDS_REVIEW: 'NEEDS_REVIEW',         // receipt above the pre-approved cap
  REIMBURSED: 'REIMBURSED',
  REJECTED: 'REJECTED',
  CANCELLED: 'CANCELLED',
});
const S = State;
// Box still empty -> at most ONE such refill per office (also a partial unique index in SQL).
export const FULFILMENT = new Set([S.BLOCKED_BUDGET, S.OFFERED, S.OPEN, S.COMMITTED]);
// Money really spent: counts against the budget at its actual amount.
export const SPENT = new Set([S.RECEIPT_RECEIVED, S.CLAIMED, S.NEEDS_REVIEW, S.REIMBURSED]);
// Volunteer still out of pocket.
export const OUTSTANDING = new Set([S.RECEIPT_RECEIVED, S.CLAIMED, S.NEEDS_REVIEW]);

export const DEFAULT_CONFIG = Object.freeze({
  offerTimeoutMs: 4 * 3600e3,        // time to answer an offer
  purchaseDeadlineMs: 24 * 3600e3,   // time to buy after accepting
  escalationRetryMs: 24 * 3600e3,    // forget exclusions after this and ask everyone again
  claimOverdueMs: 10 * 86400e3,      // HR's stated maximum
  fairnessWindowMs: 90 * 86400e3,
  reportingCurrency: 'NOK',
});

export function blankRefill(fields) {
  return {
    id: null, office: null, reportedBy: null, createdAt: null, state: S.OPEN, assignee: null,
    deadline: null, excluded: [], capMinor: null, budgetMonth: null, committedAt: null,
    amountMinor: null, receipt: null, items: {}, purchasedAt: null, claimId: null,
    claimedAt: null, reimbursedAt: null, escalatedAt: null, reminded: false,
    overdueFlagged: false, ...fields,
  };
}
