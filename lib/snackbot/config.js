// Offices and budgets, in minor units (øre / paise). Change here to change budgets.
export const OFFICES = [
  { name: 'Oslo', currency: 'NOK', monthlyBudgetMinor: 600000, minPurchaseMinor: 30000,
    maxPurchaseMinor: 120000, adminId: 'admin_oslo' },
  { name: 'Bengaluru', currency: 'INR', monthlyBudgetMinor: 1500000, minPurchaseMinor: 50000,
    maxPurchaseMinor: 300000, adminId: 'admin_blr' },
];

// Static for now. A real deployment would read a monthly rate from finance.
export const FX_RATES = { 'INR->NOK': '0.125' };

export const DEMO_USERS = [
  ...['o1', 'o2', 'o3'].map((id) => ({ id, homeOffice: 'Oslo', payrollCurrency: 'NOK' })),
  ...['b1', 'b2'].map((id) => ({ id, homeOffice: 'Bengaluru', payrollCurrency: 'INR' })),
];
