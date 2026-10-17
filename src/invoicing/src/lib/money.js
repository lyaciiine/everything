import { round2 } from './util.js';

export const CURRENCIES = [
  { code: 'DZD', name: 'Algerian Dinar (DA / دج)' },
  { code: 'USD', name: 'US Dollar' },
  { code: 'EUR', name: 'Euro' },
  { code: 'GBP', name: 'British Pound' },
  { code: 'CAD', name: 'Canadian Dollar' },
  { code: 'AUD', name: 'Australian Dollar' },
  { code: 'JPY', name: 'Japanese Yen' },
  { code: 'CHF', name: 'Swiss Franc' },
  { code: 'SEK', name: 'Swedish Krona' },
  { code: 'NOK', name: 'Norwegian Krone' },
  { code: 'DKK', name: 'Danish Krone' },
  { code: 'INR', name: 'Indian Rupee' },
  { code: 'BRL', name: 'Brazilian Real' },
  { code: 'MXN', name: 'Mexican Peso' },
  { code: 'ZAR', name: 'South African Rand' },
  { code: 'SGD', name: 'Singapore Dollar' },
  { code: 'NZD', name: 'New Zealand Dollar' },
  { code: 'AED', name: 'UAE Dirham' },
  { code: 'PLN', name: 'Polish Zloty' },
  { code: 'TRY', name: 'Turkish Lira' },
  { code: 'KES', name: 'Kenyan Shilling' },
];

const fmtCache = new Map();

export function fmtMoney(amount, currency = 'USD') {
  // Use an Algerian French number format for DZD so the local currency is
  // consistently shown as DA rather than a locale-dependent "DZD" code.
  // Two decimals are retained for calculations and accounting precision.
  if (currency === 'DZD') {
    let fmt = fmtCache.get('DZD-fr-DZ');
    if (!fmt) {
      fmt = new Intl.NumberFormat('fr-DZ', {
        minimumFractionDigits: 2,
        maximumFractionDigits: 2,
        numberingSystem: 'latn',
      });
      fmtCache.set('DZD-fr-DZ', fmt);
    }
    return `${fmt.format(Number(amount) || 0)} DA`;
  }

  let fmt = fmtCache.get(currency);
  if (!fmt) {
    try {
      fmt = new Intl.NumberFormat(undefined, { style: 'currency', currency });
    } catch {
      fmt = new Intl.NumberFormat(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
    }
    fmtCache.set(currency, fmt);
  }
  return fmt.format(Number(amount) || 0);
}

/**
 * Units a line can be billed in. Each pair is [singular, plural]: a unit the
 * user typed that matches either form prints in the form the quantity calls
 * for ("1 hour", "12 hours"), and anything else prints exactly as typed. The
 * unit is the user's own text, never translated — the paper's fixed labels
 * are the only thing lib/i18n.js speaks for.
 */
export const UNIT_FORMS = [
  ['hour', 'hours'],
  ['day', 'days'],
  ['week', 'weeks'],
  ['month', 'months'],
  ['item', 'items'],
  ['unit', 'units'],
  ['piece', 'pieces'],
  ['word', 'words'],
  ['page', 'pages'],
  ['session', 'sessions'],
  ['licence', 'licences'],
  ['license', 'licenses'],
  ['user', 'users'],
];

/** What the editor offers in its unit picker; anything else can be typed. */
export const UNIT_SUGGESTIONS = [
  'hours', 'days', 'weeks', 'months', 'each', 'items', 'words', 'pages',
  'sessions', 'licences', 'users', 'km', 'kg',
];

/**
 * One unit in the form a quantity calls for: "hour" for one, "hours" for
 * any other number. A unit this table does not know is the user's own word
 * and comes back exactly as typed.
 */
export function unitForm(unit, qty) {
  const typed = String(unit ?? '').trim();
  if (!typed) return '';
  const pair = UNIT_FORMS.find(([one, many]) => one === typed.toLowerCase() || many === typed.toLowerCase());
  if (!pair) return typed;
  const word = Math.abs(Number(qty)) === 1 ? pair[0] : pair[1];
  // A unit typed with a capital keeps it when the form changes underneath.
  return typed[0] === typed[0].toLowerCase() ? word : word[0].toUpperCase() + word.slice(1);
}

/**
 * The quantity as the paper prints it: the number, and the unit beside it
 * when the line carries one. Display only — `lineTotal` and `docTotals` never
 * look at a unit, so adding one cannot change a single figure.
 */
export function formatQty(item) {
  const qty = item?.qty;
  const shown = qty === '' || qty === null || qty === undefined ? '' : String(qty);
  const word = unitForm(item?.unit, qty);
  if (!word) return shown;
  return shown ? `${shown} ${word}` : word;
}

/** Quantity times rate for one line, rounded to cents. */
export function lineTotal(item) {
  const qty = Number(item?.qty);
  const rate = Number(item?.rate);
  if (!Number.isFinite(qty) || !Number.isFinite(rate)) return 0;
  return round2(qty * rate);
}

/**
 * Net of recorded payments on a document. Refunds are stored as negative
 * amounts, so money flowing back reduces what has been paid.
 */
export function paidTotal(doc) {
  return round2((doc?.payments || []).reduce((a, p) => a + (Number(p?.amount) || 0), 0));
}

/** True for a payment entry that sent money back to the client. */
export function isRefund(payment) {
  return (Number(payment?.amount) || 0) < 0;
}

/**
 * How much can still be refunded: never more than the client actually paid,
 * net of refunds already recorded.
 */
export function refundableTotal(doc) {
  return round2(Math.max(0, paidTotal(doc)));
}

/**
 * The named taxes a document carries: `doc.taxes` is [{ label, rate }],
 * each applying to every taxable line. Migration is read-time only — an
 * older document's single `taxRate` reads as one unnamed tax (label '',
 * which the paper renders with the settings tax label), so nothing stored
 * is ever rewritten. An explicit empty list means "no tax", even when a
 * stale `taxRate` is still sitting on the document beside it.
 */
export function docTaxes(doc) {
  if (Array.isArray(doc?.taxes)) return doc.taxes;
  const rate = Number(doc?.taxRate) || 0;
  return rate > 0 ? [{ label: '', rate }] : [];
}

/**
 * The installments a document is split into, with what each one has taken.
 *
 * `doc.schedule` is [{ id, label, dueDate, type: 'percent' | 'fixed', value }]
 * and absent means today's behaviour exactly: one due date, one balance.
 * Nothing about the allocation is stored — payments simply fill the rows in
 * date order, so a payment recorded, edited, or deleted always leaves the
 * schedule saying the truth.
 *
 * The rows always add up to the total: each one is clamped to what is left
 * of it, and the last row takes the remainder, which is where any rounding
 * lands. A schedule that asks for less than the total therefore still bills
 * the whole of it, and one that asks for more never bills past it.
 */
export function scheduleRows(doc, total, paid) {
  const rows = Array.isArray(doc?.schedule) ? doc.schedule.filter((r) => r && typeof r === 'object') : [];
  if (!rows.length) return [];
  // Date order is the order money fills them in, so it is the order they are
  // shown in too. A row with no date of its own falls in behind the ones
  // that have one, keeping its position among the others.
  const sorted = rows
    .map((r, i) => ({ row: r, i }))
    .sort((a, b) => {
      const da = String(a.row.dueDate || '\uffff');
      const db = String(b.row.dueDate || '\uffff');
      return da < db ? -1 : da > db ? 1 : a.i - b.i;
    })
    .map((x) => x.row);

  let used = 0;
  const amounts = sorted.map((r, i) => {
    if (i === sorted.length - 1) return round2(total - used);
    const raw = r.type === 'fixed'
      ? round2(Number(r.value) || 0)
      : round2(total * (Number(r.value) || 0) / 100);
    const amount = Math.min(Math.max(0, raw), Math.max(0, round2(total - used)));
    used = round2(used + amount);
    return amount;
  });

  // Money fills the rows in order: the first installment is settled before
  // the second takes anything, which is what "paid up to here" means on a
  // plan. A refund taking the net below zero simply leaves every row open.
  let left = Math.max(0, paid);
  return sorted.map((r, i) => {
    const amount = amounts[i];
    const covered = round2(Math.min(Math.max(0, amount), left));
    left = round2(left - covered);
    return {
      id: r.id || `s${i}`,
      label: String(r.label || ''),
      dueDate: r.dueDate || '',
      amount,
      paid: covered,
      open: round2(amount - covered),
    };
  });
}

/**
 * All derived money on a document. The discount applies to the subtotal and
 * tax is charged on what remains, which is how most jurisdictions expect a
 * whole-invoice discount to work. Each stage rounds to cents so the printed
 * lines always add up exactly.
 *
 * `taxes` is one row per distinct (label, rate) — Canada's GST + PST print
 * as two rows, and a mixed-rate VAT invoice shows each rate's own row. A
 * line item may carry its own `taxes` list, which replaces the document's
 * for that line: `[]` opts the line out entirely, `[{ label, rate }]` taxes
 * it differently. The discount prorates across lines before tax, so the
 * printed rows always add up to the printed total.
 *
 * `deposit` is the part of the total asked for up front — `doc.deposit` is
 * `{ type: 'percent' | 'fixed', value }` — clamped to the total the same way
 * a discount is clamped to the subtotal. It never changes what is owed
 * overall; status and balance stay derived from payments alone.
 *
 * `installments` is the same idea spread over dates: see scheduleRows above.
 * A document carries a deposit or a schedule, never both — the editor offers
 * one or the other — and neither changes what is owed in total.
 *
 * With `doc.taxInclusive` set, quoted prices already carry the tax (how most
 * of the EU, UK, Australia, and New Zealand price): the total IS the
 * discounted subtotal, and `tax` becomes the portion inside it —
 * taxable − taxable / (1 + rate/100) — reported so the paper can print
 * "Includes VAT (20%)" and reports can still say what was collected.
 */
export function docTotals(doc) {
  const subtotal = round2((doc?.items || []).reduce((a, it) => a + lineTotal(it), 0));
  let discount = 0;
  if (doc?.discountType === 'percent') {
    discount = round2(subtotal * (Number(doc.discountValue) || 0) / 100);
  } else if (doc?.discountType === 'fixed') {
    discount = round2(Number(doc.discountValue) || 0);
  }
  // A discount can neither be negative nor exceed the subtotal — and when
  // credit lines push the subtotal itself below zero, there is nothing left
  // to discount at all. Without the outer clamp, min() would "discount" a
  // negative subtotal up to zero and print arithmetic that does not add up.
  discount = Math.min(Math.max(0, discount), Math.max(0, subtotal));
  const taxable = round2(subtotal - discount);
  // How much of each gross line survives the whole-document discount.
  const factor = subtotal > 0 ? taxable / subtotal : 1;
  const inclusive = !!doc?.taxInclusive;
  // The same tax named twice is one tax, not two: rows are keyed by label
  // and rate, so a duplicate entry used to add its amount into the same row
  // and print "VAT (20%)" beside twice the money. Counted once here, and
  // refused where the lists are edited.
  const distinct = (list) => list.filter((t, i) => list.findIndex((u) => String(u.label || '').trim() === String(t.label || '').trim()
    && (Number(u.rate) || 0) === (Number(t.rate) || 0)) === i);
  const defaults = distinct(docTaxes(doc).filter((t) => Number(t?.rate) > 0));
  const rows = []; // { label, rate, amount } in first-seen order
  const rowFor = (t) => {
    const label = String(t.label || '');
    const rate = Number(t.rate) || 0;
    let row = rows.find((r) => r.label === label && r.rate === rate);
    if (!row) rows.push(row = { label, rate, amount: 0 });
    return row;
  };
  for (const it of doc?.items || []) {
    const own = Array.isArray(it?.taxes) ? distinct(it.taxes.filter((t) => Number(t?.rate) > 0)) : defaults;
    if (!own.length) continue;
    const gross = lineTotal(it) * factor;
    // Inside tax-inclusive prices the rates share one gross amount, so the
    // net is carved out once with their sum, then split proportionally.
    const sumRate = own.reduce((a, t) => a + (Number(t.rate) || 0), 0);
    const base = inclusive ? gross / (1 + sumRate / 100) : gross;
    for (const t of own) rowFor(t).amount += base * (Number(t.rate) || 0) / 100;
  }
  const taxes = rows.map((r) => ({ ...r, amount: round2(r.amount) }));
  const tax = round2(taxes.reduce((a, r) => a + r.amount, 0));
  const total = inclusive ? taxable : round2(taxable + tax);
  let deposit = 0;
  if (doc?.deposit && Number(doc.deposit.value) > 0) {
    deposit = doc.deposit.type === 'fixed'
      ? round2(Number(doc.deposit.value) || 0)
      : round2(total * (Number(doc.deposit.value) || 0) / 100);
    deposit = Math.min(Math.max(0, deposit), Math.max(0, total));
  }
  const paid = paidTotal(doc);
  const balance = round2(total - paid);
  // Derived, never stored: which part of the total is due when, and how much
  // of each part has arrived. An empty list is a document with no schedule.
  const installments = scheduleRows(doc, total, paid);
  return { subtotal, discount, taxable, tax, taxes, total, deposit, paid, balance, installments };
}

/**
 * Converting a foreign-currency figure into the user's own money.
 *
 * `doc.fxRate` is how many units of the base currency one unit of the
 * document's currency was worth on the day — entered by hand, never fetched:
 * the app makes no outbound request on the user's behalf, and a rates API
 * would mean one per document and a third party learning who bills whom.
 *
 * Absent means "not converted", never a guessed 1. A document already in the
 * base currency needs no rate and converts at parity; anything else without
 * one is excluded from consolidated figures and counted out loud, because a
 * silent parity would be a made-up number in a tax return.
 */
export function fxRateFor(doc, baseCurrency) {
  if (!baseCurrency) return null;
  if ((doc?.currency || 'USD') === baseCurrency) return 1;
  const rate = Number(doc?.fxRate);
  return Number.isFinite(rate) && rate > 0 ? rate : null;
}

/** The rate one payment converts at: its own when it carries one, else the document's. */
export function paymentFxRate(payment, doc, baseCurrency) {
  if (!baseCurrency) return null;
  if ((doc?.currency || 'USD') === baseCurrency) return 1;
  const own = Number(payment?.fxRate);
  if (Number.isFinite(own) && own > 0) return own;
  return fxRateFor(doc, baseCurrency);
}

/** An amount in the base currency, rounded to cents. */
export function inBase(amount, rate) {
  return round2((Number(amount) || 0) * (Number(rate) || 0));
}
