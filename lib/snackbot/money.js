// Money is stored as integer minor units (øre / paise). Never floats.
// Both NOK and INR have 2 decimals; add a per-currency exponent if that ever changes.
import { NotAllowed } from './model.js';

export function parseMoney(v) {
  const s = String(v).trim();
  if (!/^\d+(\.\d{1,2})?$/.test(s)) throw new NotAllowed(`invalid amount: ${s}`);
  const [whole, frac = ''] = s.split('.');
  return Number(whole) * 100 + Number((frac + '00').slice(0, 2));
}

export function formatMoney(minor) {
  return `${Math.floor(minor / 100)}.${String(minor % 100).padStart(2, '0')}`;
}

// FX rate as decimal string, e.g. "0.125" -> BigInt scaled by 1e6, rounded half up.
export function convertMinor(minor, rate) {
  const [w, f = ''] = String(rate).split('.');
  const scaled = BigInt(w) * 1_000_000n + BigInt((f + '000000').slice(0, 6));
  return Number((BigInt(minor) * scaled + 500_000n) / 1_000_000n);
}
