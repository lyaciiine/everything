import { describe, it, expect } from 'vitest';
import {
  docTotals, docTaxes, lineTotal, paidTotal, fmtMoney, CURRENCIES, isRefund, refundableTotal,
  formatQty, unitForm, scheduleRows, fxRateFor, paymentFxRate, inBase,
} from '../src/lib/money.js';

const doc = (over = {}) => ({
  kind: 'invoice',
  items: [
    { name: 'Design', qty: 2, rate: 450 },
    { name: 'Development', qty: 10.5, rate: 90 },
  ],
  taxRate: 0,
  discountType: 'none',
  discountValue: 0,
  payments: [],
  ...over,
});

describe('Algerian dinar', () => {
  it('offers DZD and formats it using Algerian French conventions with DA', () => {
    expect(CURRENCIES.some((currency) => currency.code === 'DZD')).toBe(true);
    expect(fmtMoney(1234.5, 'DZD')).toContain('234,50 DA');
    expect(fmtMoney(-50, 'DZD')).toContain('DA');
  });
});

describe('lineTotal', () => {
  it('multiplies qty by rate and rounds to cents', () => {
    expect(lineTotal({ qty: 3, rate: 33.335 })).toBe(100.01);
  });

  it('treats missing or garbage input as zero', () => {
    expect(lineTotal({})).toBe(0);
    expect(lineTotal({ qty: 'x', rate: 10 })).toBe(0);
    expect(lineTotal(null)).toBe(0);
  });
});

describe('docTotals', () => {
  it('sums line items into the subtotal', () => {
    const t = docTotals(doc());
    expect(t.subtotal).toBe(1845);
    expect(t.total).toBe(1845);
    expect(t.balance).toBe(1845);
  });

  it('applies a percent discount before tax', () => {
    const t = docTotals(doc({ discountType: 'percent', discountValue: 10, taxRate: 20 }));
    expect(t.discount).toBe(184.5);
    expect(t.taxable).toBe(1660.5);
    expect(t.tax).toBe(332.1);
    expect(t.total).toBe(1992.6);
  });

  it('applies a fixed discount and never lets it exceed the subtotal', () => {
    expect(docTotals(doc({ discountType: 'fixed', discountValue: 45 })).total).toBe(1800);
    expect(docTotals(doc({ discountType: 'fixed', discountValue: 99999 })).total).toBe(0);
  });

  it('ignores negative discounts', () => {
    expect(docTotals(doc({ discountType: 'fixed', discountValue: -50 })).discount).toBe(0);
  });

  it('never fabricates a discount when credit lines push the subtotal negative', () => {
    const t = docTotals({
      items: [{ qty: 1, rate: 100 }, { qty: -2, rate: 100 }],
      discountType: 'none', discountValue: 0, taxRate: 0,
    });
    expect(t.subtotal).toBe(-100);
    expect(t.discount).toBe(0);
    expect(t.total).toBe(-100);
  });

  it('subtracts payments from the balance', () => {
    const t = docTotals(doc({ payments: [{ amount: 1000 }, { amount: 45 }] }));
    expect(t.paid).toBe(1045);
    expect(t.balance).toBe(800);
  });

  it('rounds every stage to cents so printed lines add up', () => {
    const t = docTotals(doc({
      items: [{ qty: 1, rate: 0.1 }, { qty: 1, rate: 0.2 }],
      taxRate: 7.25,
    }));
    expect(t.subtotal).toBe(0.3);
    expect(t.tax).toBe(0.02);
    expect(t.total).toBe(0.32);
    expect(t.subtotal + t.tax).toBeCloseTo(t.total, 10);
  });

  it('handles an empty document', () => {
    const t = docTotals({ items: [] });
    expect(t).toMatchObject({ subtotal: 0, tax: 0, total: 0, balance: 0, deposit: 0 });
  });

  it('derives a percent deposit from the total, tax included', () => {
    const t = docTotals(doc({ taxRate: 10, deposit: { type: 'percent', value: 30 } }));
    expect(t.total).toBe(2029.5);
    expect(t.deposit).toBe(608.85);
  });

  it('clamps a fixed deposit to the total and refuses a negative one', () => {
    expect(docTotals(doc({ deposit: { type: 'fixed', value: 500 } })).deposit).toBe(500);
    expect(docTotals(doc({ deposit: { type: 'fixed', value: 99999 } })).deposit).toBe(1845);
    expect(docTotals(doc({ deposit: { type: 'fixed', value: -5 } })).deposit).toBe(0);
  });

  it('reads no deposit at all as zero', () => {
    expect(docTotals(doc()).deposit).toBe(0);
    expect(docTotals(doc({ deposit: { type: 'percent', value: 0 } })).deposit).toBe(0);
  });

  it('never changes the balance: a deposit is a request, not a charge', () => {
    const t = docTotals(doc({ deposit: { type: 'percent', value: 50 } }));
    expect(t.balance).toBe(t.total);
  });

  it('reads tax out of tax-inclusive prices instead of adding it', () => {
    const t = docTotals(doc({ taxRate: 20, taxInclusive: true }));
    expect(t.total).toBe(1845);          // the quoted price IS the total
    expect(t.tax).toBe(307.5);           // 1845 − 1845 / 1.2
    expect(t.balance).toBe(1845);
  });

  it('discloses inclusive tax on the discounted amount', () => {
    const t = docTotals(doc({ taxRate: 20, taxInclusive: true, discountType: 'fixed', discountValue: 45 }));
    expect(t.total).toBe(1800);
    expect(t.tax).toBe(300);
  });

  it('treats a zero rate inside inclusive prices as no tax at all', () => {
    const t = docTotals(doc({ taxRate: 0, taxInclusive: true }));
    expect(t.tax).toBe(0);
    expect(t.total).toBe(1845);
  });
});

describe('docTaxes', () => {
  it('reads a named list as-is and a legacy rate as one unnamed tax', () => {
    expect(docTaxes({ taxes: [{ label: 'GST', rate: 5 }] })).toEqual([{ label: 'GST', rate: 5 }]);
    expect(docTaxes({ taxRate: 8.5 })).toEqual([{ label: '', rate: 8.5 }]);
    expect(docTaxes({})).toEqual([]);
  });

  it('lets an explicit empty list beat a stale single rate', () => {
    expect(docTaxes({ taxes: [], taxRate: 8.5 })).toEqual([]);
  });
});

describe('docTotals named taxes', () => {
  it('keeps one row per named tax and sums them into tax', () => {
    const t = docTotals({
      items: [{ qty: 1, rate: 100 }],
      taxes: [{ label: 'GST', rate: 5 }, { label: 'PST', rate: 7 }],
    });
    expect(t.taxes).toEqual([
      { label: 'GST', rate: 5, amount: 5 },
      { label: 'PST', rate: 7, amount: 7 },
    ]);
    expect(t.tax).toBe(12);
    expect(t.total).toBe(112);
  });

  it('lets a line opt out or carry its own treatment', () => {
    const t = docTotals({
      items: [
        { qty: 1, rate: 100 },
        { qty: 1, rate: 50, taxes: [] },                           // exempt
        { qty: 1, rate: 200, taxes: [{ label: 'GST', rate: 5 }] }, // GST only
      ],
      taxes: [{ label: 'GST', rate: 5 }, { label: 'PST', rate: 7 }],
    });
    expect(t.taxes).toEqual([
      { label: 'GST', rate: 5, amount: 15 },
      { label: 'PST', rate: 7, amount: 7 },
    ]);
    expect(t.total).toBe(372);
  });

  it('shows each rate as its own row on a mixed-rate VAT invoice', () => {
    const t = docTotals({
      items: [
        { qty: 1, rate: 100 },
        { qty: 1, rate: 100, taxes: [{ label: 'VAT', rate: 7 }] },
      ],
      taxes: [{ label: 'VAT', rate: 19 }],
    });
    expect(t.taxes).toEqual([
      { label: 'VAT', rate: 19, amount: 19 },
      { label: 'VAT', rate: 7, amount: 7 },
    ]);
    expect(t.total).toBe(226);
  });

  it('prorates the whole-document discount across the taxed lines', () => {
    const t = docTotals({
      items: [{ qty: 1, rate: 100 }, { qty: 1, rate: 100, taxes: [] }],
      taxes: [{ label: 'VAT', rate: 10 }],
      discountType: 'fixed', discountValue: 20,
    });
    // The taxed line keeps 90 of its 100 once the discount spreads evenly.
    expect(t.taxes[0].amount).toBe(9);
    expect(t.total).toBe(189);
  });

  it('carves multiple inclusive taxes out of one gross price', () => {
    const t = docTotals({
      items: [{ qty: 1, rate: 112 }],
      taxes: [{ label: 'GST', rate: 5 }, { label: 'PST', rate: 7 }],
      taxInclusive: true,
    });
    expect(t.total).toBe(112);
    expect(t.taxes).toEqual([
      { label: 'GST', rate: 5, amount: 5 },
      { label: 'PST', rate: 7, amount: 7 },
    ]);
  });
});

describe('docTotals with the same tax listed twice', () => {
  it('counts an identical row once, on the document and on a line', () => {
    // Keyed by label and rate, a duplicate used to add into the same row:
    // "VAT (20%)" printed beside 40.00 on a 100.00 line.
    const t = docTotals({ items: [{ qty: 1, rate: 100 }], taxes: [{ label: 'VAT', rate: 20 }, { label: 'VAT ', rate: 20 }] });
    expect(t.taxes).toEqual([{ label: 'VAT', rate: 20, amount: 20 }]);
    expect(t.total).toBe(120);
    const own = docTotals({ items: [{ qty: 1, rate: 100, taxes: [{ label: 'GST', rate: 5 }, { label: 'GST', rate: 5 }] }], taxes: [] });
    expect(own.taxes).toEqual([{ label: 'GST', rate: 5, amount: 5 }]);
    const inclusive = docTotals({ taxInclusive: true, items: [{ qty: 1, rate: 120 }], taxes: [{ label: 'VAT', rate: 20 }, { label: 'VAT', rate: 20 }] });
    expect(inclusive.taxes[0].amount).toBe(20);
  });

  it('keeps two taxes that share a label but not a rate', () => {
    const t = docTotals({ items: [{ qty: 1, rate: 100 }], taxes: [{ label: 'Tax', rate: 5 }, { label: 'Tax', rate: 7 }] });
    expect(t.taxes.map((r) => r.amount)).toEqual([5, 7]);
  });
});

describe('paidTotal', () => {
  it('sums payment amounts, ignoring junk', () => {
    expect(paidTotal({ payments: [{ amount: 10.1 }, { amount: 'x' }, { amount: 5 }] })).toBe(15.1);
    expect(paidTotal({})).toBe(0);
  });

  it('skips a payment entry that is not an object', () => {
    expect(paidTotal({ payments: [null, { amount: 50 }] })).toBe(50);
  });
});

describe('docTotals malformed entries', () => {
  // Totals run on every list render before any view mounts, so a corrupt
  // entry from a bad restore or an external write must never throw here.
  it('ignores null items and null tax entries instead of crashing', () => {
    const t = docTotals(doc({
      items: [{ name: 'Design', qty: 1, rate: 100, taxes: [null, { label: 'VAT', rate: 10 }] }, null],
      taxes: [null],
    }));
    expect(t.subtotal).toBe(100);
    expect(t.tax).toBe(10);
    expect(t.total).toBe(110);
  });
});

describe('fmtMoney', () => {
  it('formats with the currency attached', () => {
    const s = fmtMoney(1234.5, 'USD');
    expect(s).toMatch(/1,?234/);
    expect(s).toMatch(/[$]|USD/);
  });

  it('survives an unknown currency code', () => {
    expect(() => fmtMoney(10, 'NOPE!')).not.toThrow();
  });
});

describe('refunds', () => {
  it('nets a refund out of what has been paid', () => {
    const d = doc({ payments: [{ amount: 900 }, { amount: -250 }] });
    expect(paidTotal(d)).toBe(650);
    const t = docTotals(d);
    expect(t.total).toBe(1845);
    expect(t.paid).toBe(650);
    expect(t.balance).toBe(1195);
  });

  it('reopens the balance of an invoice that was paid in full', () => {
    const d = doc({ payments: [{ amount: 1845 }, { amount: -845 }] });
    const t = docTotals(d);
    expect(t.paid).toBe(1000);
    expect(t.balance).toBe(845);
  });

  it('knows a refund from a payment', () => {
    expect(isRefund({ amount: -1 })).toBe(true);
    expect(isRefund({ amount: 1 })).toBe(false);
    expect(isRefund({ amount: 0 })).toBe(false);
    expect(isRefund({})).toBe(false);
    expect(isRefund(null)).toBe(false);
  });

  it('caps what can be refunded at what came in', () => {
    expect(refundableTotal(doc({ payments: [{ amount: 500 }] }))).toBe(500);
    expect(refundableTotal(doc({ payments: [{ amount: 500 }, { amount: -200 }] }))).toBe(300);
    expect(refundableTotal(doc({ payments: [{ amount: 500 }, { amount: -500 }] }))).toBe(0);
    expect(refundableTotal(doc())).toBe(0);
  });

  it('rounds a part-refund of a rounded payment to cents', () => {
    const d = doc({ payments: [{ amount: 33.33 }, { amount: -11.11 }] });
    expect(paidTotal(d)).toBe(22.22);
  });
});

describe('units on a line', () => {
  it('prints the quantity with the unit beside it', () => {
    expect(formatQty({ qty: 12, unit: 'hours' })).toBe('12 hours');
    expect(formatQty({ qty: 4, unit: 'day' })).toBe('4 days');
  });

  it('agrees with the quantity, whichever form was typed', () => {
    expect(formatQty({ qty: 1, unit: 'hours' })).toBe('1 hour');
    expect(formatQty({ qty: 1, unit: 'hour' })).toBe('1 hour');
    expect(formatQty({ qty: 2.5, unit: 'hour' })).toBe('2.5 hours');
    expect(unitForm('days', 1)).toBe('day');
    expect(unitForm('day', 0)).toBe('days');
  });

  it("leaves a word it does not know exactly as typed", () => {
    expect(formatQty({ qty: 3, unit: 'Stunden' })).toBe('3 Stunden');
    expect(formatQty({ qty: 1, unit: 'km' })).toBe('1 km');
    expect(unitForm('  ', 2)).toBe('');
  });

  it('keeps the capital a unit was typed with', () => {
    expect(formatQty({ qty: 2, unit: 'Hour' })).toBe('2 Hours');
  });

  it('renders a line without a unit exactly as before', () => {
    expect(formatQty({ qty: 12 })).toBe('12');
    expect(formatQty({ qty: 12, unit: '' })).toBe('12');
    expect(formatQty({})).toBe('');
  });

  it('changes no figure: a unit is display only', () => {
    const plain = doc({ items: [{ name: 'Design', qty: 4, rate: 800 }] });
    const united = doc({ items: [{ name: 'Design', qty: 4, rate: 800, unit: 'hours' }] });
    expect(lineTotal(united.items[0])).toBe(lineTotal(plain.items[0]));
    expect(docTotals(united)).toEqual(docTotals(plain));
  });
});

describe('payment schedules', () => {
  // Subtotal 1,845: two lines of 900 and 945.
  const plan = (schedule, over = {}) => doc({ schedule, ...over });
  const half = [
    { id: 'a', label: 'On signing', dueDate: '2026-08-01', type: 'percent', value: 50 },
    { id: 'b', label: 'On delivery', dueDate: '2026-09-01', type: 'percent', value: 50 },
  ];

  it('is absent from a document that has no schedule', () => {
    expect(docTotals(doc()).installments).toEqual([]);
    expect(docTotals(doc({ schedule: [] })).installments).toEqual([]);
  });

  it('splits the total and never changes it', () => {
    const t = docTotals(plan(half));
    expect(t.total).toBe(1845);
    expect(t.installments.map((r) => r.amount)).toEqual([922.5, 922.5]);
    expect(t.balance).toBe(1845);
  });

  it('lets the last row absorb the rounding, so the rows always add up', () => {
    const thirds = [1, 2, 3].map((n) => ({
      id: `r${n}`, dueDate: `2026-0${n + 7}-01`, type: 'percent', value: 33.333,
    }));
    const t = docTotals(plan(thirds));
    const sum = t.installments.reduce((a, r) => a + r.amount, 0);
    expect(Math.round(sum * 100) / 100).toBe(t.total);
    expect(t.installments[2].amount).toBeCloseTo(1845 - 614.99 * 2, 2);
  });

  it('clamps a row to what is left, and never bills past the total', () => {
    const greedy = [
      { id: 'a', dueDate: '2026-08-01', type: 'fixed', value: 5000 },
      { id: 'b', dueDate: '2026-09-01', type: 'fixed', value: 5000 },
    ];
    const t = docTotals(plan(greedy));
    expect(t.installments.map((r) => r.amount)).toEqual([1845, 0]);
  });

  it('gives the last row the remainder when the rows ask for too little', () => {
    const short = [
      { id: 'a', dueDate: '2026-08-01', type: 'fixed', value: 500 },
      { id: 'b', dueDate: '2026-09-01', type: 'fixed', value: 100 },
    ];
    expect(docTotals(plan(short)).installments.map((r) => r.amount)).toEqual([500, 1345]);
  });

  it('refuses a negative share', () => {
    const bad = [
      { id: 'a', dueDate: '2026-08-01', type: 'fixed', value: -400 },
      { id: 'b', dueDate: '2026-09-01', type: 'percent', value: 10 },
    ];
    expect(docTotals(plan(bad)).installments.map((r) => r.amount)).toEqual([0, 1845]);
  });

  it('fills the rows in date order, whatever order they were typed in', () => {
    const reversed = [half[1], half[0]];
    const t = docTotals(plan(reversed, { payments: [{ amount: 1000 }] }));
    expect(t.installments.map((r) => r.id)).toEqual(['a', 'b']);
    expect(t.installments[0]).toMatchObject({ paid: 922.5, open: 0 });
    expect(t.installments[1]).toMatchObject({ paid: 77.5, open: 845 });
  });

  it('leaves every row open when refunds take the net below zero', () => {
    const t = docTotals(plan(half, { payments: [{ amount: 500 }, { amount: -600 }] }));
    expect(t.installments.every((r) => r.paid === 0)).toBe(true);
  });

  it('sorts a row with no date of its own behind the dated ones', () => {
    const mixed = [
      { id: 'a', dueDate: '', type: 'percent', value: 25 },
      { id: 'b', dueDate: '2026-08-01', type: 'percent', value: 25 },
    ];
    expect(docTotals(plan(mixed)).installments.map((r) => r.id)).toEqual(['b', 'a']);
  });

  it('ignores junk rows rather than throwing', () => {
    expect(scheduleRows({ schedule: [null, 'x'] }, 100, 0)).toEqual([]);
    expect(scheduleRows({ schedule: [{ id: 'a', type: 'percent' }] }, 100, 0)[0].amount).toBe(100);
  });
});

describe('exchange rates', () => {
  it('needs none when the document is already in the base currency', () => {
    expect(fxRateFor({ currency: 'USD' }, 'USD')).toBe(1);
  });

  it('reads a stored rate, and refuses a useless one', () => {
    expect(fxRateFor({ currency: 'EUR', fxRate: 1.08 }, 'USD')).toBe(1.08);
    expect(fxRateFor({ currency: 'EUR' }, 'USD')).toBe(null);
    expect(fxRateFor({ currency: 'EUR', fxRate: 0 }, 'USD')).toBe(null);
    expect(fxRateFor({ currency: 'EUR', fxRate: -1 }, 'USD')).toBe(null);
    expect(fxRateFor({ currency: 'EUR', fxRate: 'x' }, 'USD')).toBe(null);
  });

  it('has no answer at all without a base currency', () => {
    expect(fxRateFor({ currency: 'EUR', fxRate: 2 }, '')).toBe(null);
  });

  it('lets a payment carry its own rate, falling back to the document’s', () => {
    const doc = { currency: 'EUR', fxRate: 1.1 };
    expect(paymentFxRate({ fxRate: 1.3 }, doc, 'USD')).toBe(1.3);
    expect(paymentFxRate({}, doc, 'USD')).toBe(1.1);
    expect(paymentFxRate({ fxRate: 0 }, doc, 'USD')).toBe(1.1);
    expect(paymentFxRate({}, { currency: 'EUR' }, 'USD')).toBe(null);
  });

  it('converts to cents', () => {
    expect(inBase(1000, 1.085)).toBe(1085);
    expect(inBase(33.33, 1.1)).toBe(36.66);
    expect(inBase('x', 2)).toBe(0);
  });
});
