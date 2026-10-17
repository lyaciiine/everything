/**
 * Turning a document into the shape lib/pdf.js draws.
 *
 * Kept apart from the renderer so that renderer stays import-free (it is
 * inlined verbatim into public share pages), and so the mapping from app data
 * to paper — the part with the business rules in it — is testable on its own.
 *
 * Fixed labels arrive already translated into the document's language
 * (lib/i18n.js); the renderer just draws strings.
 */

import { fmtMoney, docTotals, lineTotal, isRefund, formatQty } from './money.js';
import { fmtDateLocale } from './dates.js';
import { docStatus, dueDateFor } from './doc.js';
import { docPaymentInstructions } from './paylink.js';
import { lateFeePolicy, lateFeeText } from './latefee.js';
import { docTaxNote } from './taxnote.js';
import { docLang, translator } from './i18n.js';
import { aging, statementAgingRows, overdueAmount, ANY_ISSUE_DATE } from './aging.js';
import { logoOf, brandColorOf } from './brand.js';
import { round2 } from './util.js';

/** Stamp colors, matching the print stylesheet's tones. */
const STAMP_COLOR = {
  ok: '#0d7a3f',
  bad: '#c22f2f',
  warn: '#955f00',
  neutral: '#5b5e66',
  info: '#2b49c4',
};

/** The stamped statuses and their tones; labels come from the language. */
const STAMPS = {
  paid: { key: 'statusPaid', tone: 'ok' },
  overdue: { key: 'statusOverdue', tone: 'bad' },
  void: { key: 'statusVoid', tone: 'neutral' },
  accepted: { key: 'statusAccepted', tone: 'ok' },
  declined: { key: 'statusDeclined', tone: 'bad' },
  expired: { key: 'statusExpired', tone: 'warn' },
};

/**
 * Characters the built-in PDF fonts cannot draw. The digit-grouping
 * spaces and the true minus sign that number formatting emits in many
 * locales are fine: winAnsi() folds them to their WinAnsi lookalikes.
 * The zero-width/bidi marks RTL locales wrap numbers in are fine too:
 * winAnsi() drops them.
 */
const UNSUPPORTED = /[^\0-ÿ–—‘’“”…•€™\u2007\u2009\u202F\u2212\u200B-\u200F\u061C\uFEFF]/;

/**
 * Money for the PDF. Symbols outside WinAnsi (the rupee, the lira) would come
 * out as '?', so those currencies fall back to their ISO code, which every
 * viewer can render and every reader understands. The fallback must fix the
 * digits too, not just the symbol — several locales write digits WinAnsi
 * cannot draw (Arabic-Indic, Bengali) — so it forces Latin numerals and its
 * output is re-tested rather than trusted.
 */
export function pdfMoney(amount, currency) {
  const formatted = fmtMoney(amount, currency);
  if (!UNSUPPORTED.test(formatted)) return formatted;
  try {
    const coded = new Intl.NumberFormat(undefined, {
      style: 'currency', currency, currencyDisplay: 'code', numberingSystem: 'latn',
    }).format(Number(amount) || 0);
    if (!UNSUPPORTED.test(coded)) return coded;
  } catch { /* an unknown currency code lands on the plain form below */ }
  return `${currency} ${(Number(amount) || 0).toFixed(2)}`;
}

/**
 * A date for the PDF. A document with no language of its own is dated in
 * the app's locale, and some locales write digits or month names WinAnsi
 * cannot draw; those fall back to the ISO date itself — unambiguous, and
 * always drawable — rather than a row of '?'.
 */
export function pdfDate(iso, lang) {
  const formatted = fmtDateLocale(iso, lang);
  return UNSUPPORTED.test(formatted) ? String(iso) : formatted;
}

const lines = (...values) => values
  .flatMap((v) => String(v ?? '').split('\n'))
  .map((v) => v.trim())
  .filter(Boolean);

function bizBlock(settings, tr) {
  const b = settings?.business || {};
  return {
    name: b.name || 'Your business',
    lines: lines(
      b.address,
      b.email,
      b.phone,
      b.taxId ? `${tr('taxId')}: ${b.taxId}` : '',
      b.nif ? `NIF: ${b.nif}` : '',
      b.nis ? `NIS: ${b.nis}` : '',
      b.rc ? `RC: ${b.rc}` : '',
    ),
  };
}

function clientBlock(client, label, tr) {
  if (!client) return { label, name: tr('noClient'), lines: [] };
  // The company only joins the detail lines when it is not already the
  // displayed name — a company-only client borrows it for the name above.
  const name = client.name || client.company || 'Client';
  return {
    label,
    name,
    lines: lines(client.company !== name ? client.company : '', client.address, client.email,
      client.taxId ? `${tr('taxId')}: ${client.taxId}` : ''),
  };
}

const shell = (settings, tr) => ({
  logo: logoOf(settings),
  brand: brandColorOf(settings),
  // Page geometry for the PDF writer. Only the two names it knows are ever
  // stored; anything else (or nothing) renders as A4, exactly as before.
  paper: settings?.paperSize === 'letter' ? 'letter' : 'a4',
  pageOf: tr('pageOf'),
  // The heading over the pay link, in the document's language like every
  // other label; the writer drew a hardcoded English one over a translated
  // sheet.
  payOnline: tr('payOnline'),
  biz: bizBlock(settings, tr),
});

/** An invoice or estimate, exactly as the paper renders it. */
export function docSpec(doc, client, settings, { today = null, payLink = null } = {}) {
  const t = docTotals(doc);
  const lang = docLang(doc, client) || settings.defaultLanguage || '';
  const tr = translator(lang);
  const isInvoice = doc.kind === 'invoice';
  // As the paper does: without a date the stamp is what the document says
  // about itself (void, paid, accepted, declined), never the clock's reading.
  const status = docStatus(doc, today);
  const stamp = STAMPS[status]
    ? { label: tr(STAMPS[status].key), color: STAMP_COLOR[STAMPS[status].tone] }
    : null;

  // Mirrors the paper: one row per named tax, legacy single-rate documents
  // borrowing the settings label.
  const taxRow = (x) => `${x.label || settings.taxLabel || 'Tax'} (${x.rate}%)`;
  const taxRows = t.taxes.filter((x) => Math.abs(x.amount) > 0.005);
  const totals = [
    { label: tr('subtotal'), value: pdfMoney(t.subtotal, doc.currency) },
    t.discount > 0 && {
      label: `${tr('discount')}${doc.discountType === 'percent' ? ` (${doc.discountValue}%)` : ''}`,
      value: pdfMoney(-t.discount, doc.currency),
    },
    ...(doc.taxInclusive ? [] : taxRows.map((x) => ({
      label: taxRow(x), value: pdfMoney(x.amount, doc.currency),
    }))),
    { label: tr('total'), value: pdfMoney(t.total, doc.currency), strong: true },
    ...(doc.taxInclusive ? taxRows.map((x) => ({
      label: `${tr('includes')} ${taxRow(x)}`, value: pdfMoney(x.amount, doc.currency),
    })) : []),
    // Mirrors the paper: the up-front ask shows only while nothing is paid.
    t.deposit > 0.005 && Math.abs(t.paid) <= 0.005 && {
      label: `${tr('depositDue')}${doc.deposit?.type === 'percent' ? ` (${doc.deposit.value}%)` : ''}`,
      value: pdfMoney(t.deposit, doc.currency),
      strong: true,
    },
    isInvoice && Math.abs(t.paid) > 0.005 && {
      label: tr('paid'), value: pdfMoney(-t.paid, doc.currency),
    },
    isInvoice && Math.abs(t.paid) > 0.005 && {
      label: tr('balanceDue'), value: pdfMoney(t.balance, doc.currency), strong: true,
    },
    // Mirrors the paper: the payment plan under the totals it splits, each
    // row saying when, what for, how much, and what is still open on it.
    ...(t.installments.length
      ? [{ label: tr('paymentSchedule'), value: '' },
        ...t.installments.map((row) => {
          const when = row.dueDate ? pdfDate(row.dueDate, lang) : tr('onReceipt');
          const state = row.open <= 0.005
            ? tr('paid')
            : row.paid > 0.005
              ? tr('installmentOpen', { amount: pdfMoney(row.open, doc.currency) })
              : '';
          return {
            label: [when, row.label, state].filter(Boolean).join(' · '),
            value: pdfMoney(row.amount, doc.currency),
          };
        })]
      : []),
  ].filter(Boolean);

  return {
    ...shell(settings, tr),
    filename: doc.number,
    language: lang,
    kind: tr(isInvoice ? 'invoice' : 'estimate'),
    number: doc.number,
    stamp,
    party: clientBlock(client, tr(isInvoice ? 'billedTo' : 'preparedFor'), tr),
    dates: [
      [tr('issued'), pdfDate(doc.issueDate, lang)],
      // Mirrors the paper: a due-less invoice is due on receipt (a real
      // term); an estimate with no valid-until has no expiry row at all; on
      // a payment plan the date is the earliest installment still open.
      ...(isInvoice
        ? [[tr('due'), pdfDate(dueDateFor(doc, t.installments), lang) || tr('onReceipt')]]
        : pdfDate(doc.validUntil, lang)
          ? [[tr('validUntil'), pdfDate(doc.validUntil, lang)]]
          : []),
      ...(doc.reference ? [[tr('reference'), doc.reference]] : []),
    ],
    table: {
      head: [tr('description'), tr('qty'), tr('rate'), tr('amount')],
      align: ['left', 'right', 'right', 'right'],
      // The description keeps its own column short of the quantity, so a
      // wrapped line and a number never end up touching. A document billing
      // in units writes words in that column ("12 hours"), so it lends the
      // quantity room the description can spare; one that carries no unit
      // keeps the geometry it always had.
      widths: (doc.items || []).some((it) => String(it?.unit ?? '').trim())
        ? [0.4, 0.22, 0.19, 0.19]
        : [0.48, 0.14, 0.19, 0.19],
      empty: tr('noLineItems'),
      // A line with its own work description hands the writer a two-part
      // cell: the name, and the smaller sub-text drawn under it — the same
      // reading the HTML paper gives it.
      rows: (doc.items || []).map((it) => [
        it.details ? { text: it.name || '', sub: it.details } : (it.name || ''),
        formatQty(it),
        pdfMoney(it.rate, doc.currency),
        pdfMoney(lineTotal(it), doc.currency),
      ]),
    },
    totals,
    notes: doc.notes ? { label: tr('notes'), text: doc.notes } : null,
    instructions: (() => {
      const text = docPaymentInstructions(settings, doc, client);
      return text ? { label: tr('paymentDetails'), text } : null;
    })(),
    taxNote: (() => {
      const text = docTaxNote(settings, doc, client, tr);
      return text ? { label: tr('taxNoteLabel'), text } : null;
    })(),
    lateFee: (() => {
      if (!isInvoice || doc.status === 'void' || t.balance <= 0.005) return null;
      const text = lateFeeText(lateFeePolicy(settings, client), doc.currency, pdfMoney, tr);
      return text ? { label: tr('lateFee'), text } : null;
    })(),
    payLink: payLink && isInvoice && t.balance > 0.005 ? payLink : null,
  };
}

/** A receipt for one payment, or a refund receipt for money sent back. */
export function receiptSpec(payment, doc, client, settings) {
  const t = docTotals(doc);
  const lang = docLang(doc, client);
  const tr = translator(lang);
  const refund = isRefund(payment);
  return {
    ...shell(settings, tr),
    filename: payment.number || 'receipt',
    language: lang,
    kind: tr(refund ? 'refundReceipt' : 'receipt'),
    number: payment.number || '',
    party: clientBlock(client, tr(refund ? 'refundedTo' : 'receivedFrom'), tr),
    dates: [
      [tr('date'), pdfDate(payment.date, lang)],
      [tr('for'), doc.number],
    ],
    amount: {
      label: tr(refund ? 'amountRefunded' : 'amountReceived'),
      value: pdfMoney(Math.abs(Number(payment.amount) || 0), doc.currency),
      sub: lines(payment.method ? `${tr('via')} ${payment.method}` : '', payment.note),
    },
    totals: [
      { label: tr('invoiceTotal'), value: pdfMoney(t.total, doc.currency) },
      { label: tr('paidToDate'), value: pdfMoney(t.paid, doc.currency) },
      { label: tr('balance'), value: pdfMoney(t.balance, doc.currency), strong: true },
    ],
  };
}

/** A statement of account: one client's open invoices on one page. */
export function statementSpec(client, docs, settings, { today = null } = {}) {
  const lang = docLang(null, client) || settings.defaultLanguage || '';
  const tr = translator(lang);
  const rows = [...docs].sort((a, b) => (a.issueDate < b.issueDate ? -1 : a.issueDate > b.issueDate ? 1 : 0));
  const due = {};
  const overdue = {};
  // Mirrors the paper: an invoice on a payment plan is measured against its
  // earliest open installment, not its final date.
  const dueOn = new Map(rows.map((doc) => [doc, dueDateFor(doc)]));
  for (const doc of rows) {
    const { balance } = docTotals(doc);
    due[doc.currency] = round2((due[doc.currency] || 0) + balance);
    // Mirrors the paper: only the part that is actually late.
    const late = today ? overdueAmount(doc, today) : 0;
    if (late > 0.005) overdue[doc.currency] = round2((overdue[doc.currency] || 0) + late);
  }
  const multi = Object.keys(due).length > 1;
  const aged = today ? aging(rows, [], {
    asOf: today,
    // Every invoice on the statement is aged, however it is dated: the
    // breakdown sits under a total that already counts all of them.
    issuedThrough: ANY_ISSUE_DATE,
  }) : { currencies: [], totals: {} };
  const ageRows = statementAgingRows(aged, tr, { multi });
  const name = client?.company || client?.name || 'Client';

  return {
    ...shell(settings, tr),
    filename: `statement-${name}`,
    language: lang,
    kind: tr('statement'),
    number: '',
    subtitle: today ? `${tr('asOf')} ${pdfDate(today, lang)}` : '',
    party: clientBlock(client, tr('accountOf'), tr),
    dates: [[tr('openInvoices'), String(rows.length)]],
    table: {
      head: [tr('invoice'), tr('issued'), tr('due'), tr('amount'), tr('balance')],
      align: ['left', 'left', 'left', 'right', 'right'],
      widths: [0.19, 0.19, 0.22, 0.2, 0.2],
      boldFirst: true,
      empty: tr('nothingOutstanding'),
      rows: rows.map((doc) => {
        const t = docTotals(doc);
        const on = dueOn.get(doc);
        const late = today && on && on < today;
        return [
          doc.number,
          pdfDate(doc.issueDate, lang),
          `${on ? pdfDate(on, lang) : tr('onReceipt')}${late ? ` · ${tr('overdueFlag')}` : ''}`,
          pdfMoney(t.total, doc.currency),
          pdfMoney(t.balance, doc.currency),
        ];
      }),
    },
    totals: [
      ...Object.entries(due).map(([currency, amount]) => ({
        label: `${tr('totalDue')}${multi ? ` (${currency})` : ''}`,
        value: pdfMoney(amount, currency),
        strong: true,
      })),
      ...Object.entries(overdue).map(([currency, amount]) => ({
        label: `${tr('ofWhichOverdue')}${multi ? ` (${currency})` : ''}`,
        value: pdfMoney(amount, currency),
      })),
      // Mirrors the paper: the aging summary under the totals, headed by a
      // label of its own and skipped when every balance sits in one bucket.
      ...(ageRows.length
        ? [{ label: tr('agingTitle'), value: '' },
          ...ageRows.map(([label, amount, currency]) => ({
            label, value: pdfMoney(amount, currency),
          }))]
        : []),
    ],
    notes: settings.defaultNotes ? { label: tr('notes'), text: settings.defaultNotes } : null,
  };
}
