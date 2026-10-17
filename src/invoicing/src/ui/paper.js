/**
 * The document "paper": one HTML renderer used by the in-app preview, the
 * print output, and the public share page, so a client always sees exactly
 * what the user saw. The paper is deliberately always light, like paper.
 * All user data is escaped here; callers pass raw strings.
 *
 * Fixed labels render in the document's language (lib/i18n.js) — the
 * client's language, or a per-document override — while everything the
 * user typed prints verbatim.
 */

import { esc, round2 } from '../lib/util.js';
import { fmtMoney, docTotals, lineTotal, isRefund, formatQty } from '../lib/money.js';
import { fmtDateLocale } from '../lib/dates.js';
import { docStatus, dueDateFor } from '../lib/doc.js';
import { docPaymentInstructions } from '../lib/paylink.js';
import { lateFeePolicy, lateFeeText } from '../lib/latefee.js';
import { docTaxNote } from '../lib/taxnote.js';
import { docLang, translator } from '../lib/i18n.js';
import { aging, statementAgingRows, overdueAmount, ANY_ISSUE_DATE } from '../lib/aging.js';
import { logoOf, brandColorOf } from '../lib/brand.js';

const multiline = (s) => esc(s).replaceAll('\n', '<br>');

/**
 * A formatted date, safe to interpolate into the paper's HTML. fmtDate
 * echoes its raw input back when the date cannot be parsed, so an
 * unparseable value (e.g. one smuggled in through a restored backup, which
 * keeps date fields verbatim) would otherwise reach innerHTML unescaped.
 * Every other field on the paper already goes through esc(); dates now too.
 */
const fmtDateSafe = (iso, lang) => esc(fmtDateLocale(iso, lang));

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
 * ` style="prop:#hex"` when a brand color is set, otherwise nothing, so an
 * unbranded paper renders byte-identical to before. The color comes from
 * brandColorOf(), which only ever returns a literal hex.
 */
const tint = (prop, brand) => (brand ? ` style="${prop}:${brand}"` : '');

function bizBlock(settings, t) {
  const b = settings.business || {};
  const logo = logoOf(settings);
  const meta = [
    b.address, b.email, b.phone,
    b.taxId ? `${t('taxId')}: ${b.taxId}` : '',
    b.nif ? `NIF: ${b.nif}` : '',
    b.nis ? `NIS: ${b.nis}` : '',
    b.rc ? `RC: ${b.rc}` : '',
  ].filter(Boolean).map(multiline).join('<br>');
  return `
    <div class="paper-biz">
      ${logo ? `<img class="paper-logo" src="${esc(logo)}" alt="">` : ''}
      <div class="paper-biz-name">${esc(b.name || 'Your business')}</div>
      ${meta ? `<div class="paper-sub">${meta}</div>` : ''}
    </div>`;
}

/**
 * The displayed name falls back to the company (a client entered with no
 * contact person must not render a blank line), and the company only joins
 * the detail lines when it is not already the name above them — a client
 * whose name and company match would otherwise print twice. Mirrors the
 * PDF's clientBlock in pdf-spec.js, which draws the same paper as a file.
 */
function clientBlock(client, t) {
  if (!client) return `<div class="paper-sub">${esc(t('noClient'))}</div>`;
  const name = client.name || client.company || 'Client';
  const meta = [client.company !== name ? client.company : '', client.address, client.email,
    client.taxId ? `${t('taxId')}: ${client.taxId}` : '']
    .filter(Boolean).map(multiline).join('<br>');
  return `
    <div class="paper-client-name">${esc(name)}</div>
    ${meta ? `<div class="paper-sub">${meta}</div>` : ''}`;
}

/**
 * paperHTML(doc, client, settings, { payLink, today })
 * `payLink` adds a payment row; `today` drives the status stamp.
 */
export function paperHTML(doc, client, settings, { payLink = null, today = null } = {}) {
  const t = docTotals(doc);
  const lang = docLang(doc, client);
  const tr = translator(lang);
  const brand = brandColorOf(settings);
  const isInvoice = doc.kind === 'invoice';
  // Derived here rather than passed in, so every paper (preview, print,
  // share page) agrees on when bank details belong on the document.
  const payInstructions = docPaymentInstructions(settings, doc, client);
  // The late-fee disclosure follows the same rule: only an invoice that
  // still asks for money warns about paying it late.
  const lateFee = isInvoice && doc.status !== 'void' && t.balance > 0.005
    ? lateFeeText(lateFeePolicy(settings, client), doc.currency, fmtMoney, tr)
    : '';
  // Why no tax was charged, when none was: derived here like the pay link
  // and the late-fee disclosure, so no caller can leave a legally required
  // sentence off one rendering of the same document.
  const taxNote = docTaxNote(settings, doc, client, tr);
  // Without `today` (the share page, which is a static file) the status
  // still carries what the document says about itself — void, paid, accepted,
  // declined — and never what the clock says. A voided invoice's public page
  // used to read as a live invoice with its pay link quietly gone: a client
  // opening the link they were sent saw a total and no way to settle it.
  const status = docStatus(doc, today);
  const stamp = STAMPS[status]
    ? `<div class="paper-stamp tone-${STAMPS[status].tone}">${esc(tr(STAMPS[status].key))}</div>`
    : '';

  // A line's own work description prints under its name — the timekeeper (or
  // the task) above, what the hours were actually spent on beneath.
  const rows = (doc.items || []).map((it) => `
    <tr>
      <td>${esc(it.name)}${it.details ? `<div class="paper-item-details">${multiline(it.details)}</div>` : ''}</td>
      <td class="num">${esc(formatQty(it))}</td>
      <td class="num">${fmtMoney(it.rate, doc.currency)}</td>
      <td class="num">${fmtMoney(lineTotal(it), doc.currency)}</td>
    </tr>`).join('');

  // One row per named tax; a legacy single-rate document reads as one
  // unnamed tax, which borrows the settings label exactly as before.
  const taxRow = (x) => `${esc(String(x.label || settings.taxLabel || 'Tax'))} (${esc(String(x.rate))}%)`;
  // Sign-blind, like the Paid row below: a credit line taxed on its own nets
  // a negative row, and dropping it left Subtotal and Total not adding up.
  const taxRows = t.taxes.filter((x) => Math.abs(x.amount) > 0.005);
  const totals = [
    [tr('subtotal'), t.subtotal, false],
    t.discount > 0 && [`${tr('discount')}${doc.discountType === 'percent' ? ` (${esc(String(doc.discountValue))}%)` : ''}`, -t.discount, false],
    // Tax added on top is a stage of the sum; tax already inside the prices
    // is a disclosure, printed under the total it is part of.
    ...(doc.taxInclusive ? [] : taxRows.map((x) => [taxRow(x), x.amount, false])),
    [tr('total'), t.total, true],
    ...(doc.taxInclusive ? taxRows.map((x) => [`${tr('includes')} ${taxRow(x)}`, x.amount, false]) : []),
    // The part asked for up front, shown while nothing has been paid. From
    // the first payment on, the Paid and Balance rows tell the real story
    // and a stale "deposit due" would only contradict them.
    t.deposit > 0.005 && Math.abs(t.paid) <= 0.005
      && [`${tr('depositDue')}${doc.deposit?.type === 'percent' ? ` (${esc(String(doc.deposit.value))}%)` : ''}`, t.deposit, true],
    // Any nonzero net of payments earns the Paid and Balance rows — the net
    // can be negative once a payment is deleted out from under its refund,
    // and hiding the rows then would print a total the client no longer
    // owes. Matches the PDF (docSpec), which is the same paper as a file.
    isInvoice && Math.abs(t.paid) > 0.005 && [tr('paid'), -t.paid, false],
    isInvoice && Math.abs(t.paid) > 0.005 && [tr('balanceDue'), t.balance, true],
  ].filter(Boolean).map(([label, amount, strong]) => `
    <div class="paper-trow${strong ? ' strong' : ''}"${strong ? tint('border-top-color', brand) : ''}>
      <span>${label}</span>
      <span class="num">${fmtMoney(amount, doc.currency)}</span>
    </div>`).join('');

  // The plan the total is split into, under the totals it adds up to: date,
  // what the part is for, its amount, and what is still open on it. Derived
  // from docTotals, so the paper, the PDF, and the share page cannot differ.
  const schedule = t.installments.length ? `
      <div class="paper-schedule">
        <div class="paper-label">${esc(tr('paymentSchedule'))}</div>
        ${t.installments.map((row) => {
    const when = row.dueDate ? fmtDateSafe(row.dueDate, lang) : esc(tr('onReceipt'));
    const state = row.open <= 0.005
      ? esc(tr('paid'))
      : row.paid > 0.005
        ? esc(tr('installmentOpen', { amount: fmtMoney(row.open, doc.currency) }))
        : '';
    return `
        <div class="paper-trow">
          <span>${when}${row.label ? ` · ${esc(row.label)}` : ''}${state ? ` · <span class="paper-inst-state">${state}</span>` : ''}</span>
          <span class="num">${fmtMoney(row.amount, doc.currency)}</span>
        </div>`;
  }).join('')}
      </div>` : '';

  return `
  <div class="paper-head">
    ${bizBlock(settings, tr)}
    <div class="paper-id">
      <div class="paper-kind"${tint('color', brand)}>${esc(tr(isInvoice ? 'invoice' : 'estimate'))}</div>
      <div class="paper-number">${esc(doc.number)}</div>
      ${stamp}
    </div>
  </div>
  <div class="paper-parties">
    <div>
      <div class="paper-label">${esc(tr(isInvoice ? 'billedTo' : 'preparedFor'))}</div>
      ${clientBlock(client, tr)}
    </div>
    <div class="paper-dates">
      <div class="paper-label">${esc(tr('issued'))}</div>
      <div>${fmtDateSafe(doc.issueDate, lang)}</div>
      ${(() => {
        // An invoice with no due date is due on receipt — a real term. An
        // estimate with no valid-until (legacy or imported data) simply has
        // no expiry to print: "Valid until: On receipt" would be nonsense.
        // On a payment plan the date is the earliest installment still open
        // — the one the stamp, the reminder and the statement all measure
        // from. The invoice's own date printed here beside a schedule that
        // asked for nothing on it, so the client read one due date in the
        // header and another in the plan under the totals.
        const value = isInvoice
          ? fmtDateSafe(dueDateFor(doc, t.installments), lang) || esc(tr('onReceipt'))
          : fmtDateSafe(doc.validUntil, lang);
        return value ? `<div class="paper-label">${esc(tr(isInvoice ? 'due' : 'validUntil'))}</div>
      <div>${value}</div>` : '';
      })()}
      ${doc.reference ? `<div class="paper-label">${esc(tr('reference'))}</div>
      <div>${esc(doc.reference)}</div>` : ''}
    </div>
  </div>
  <div class="paper-table-scroll" tabindex="0" role="region" aria-label="${esc(tr('lineItems'))}">
  <table class="paper-table">
    <thead>
      <tr>${[[tr('description'), ''], [tr('qty'), ' class="num"'], [tr('rate'), ' class="num"'], [tr('amount'), ' class="num"']]
    .map(([label, cls]) => `<th scope="col"${cls}${tint('border-bottom-color', brand)}>${esc(label)}</th>`).join('')}</tr>
    </thead>
    <tbody>${rows || `<tr><td colspan="4" class="paper-sub">${esc(tr('noLineItems'))}</td></tr>`}</tbody>
  </table>
  </div>
  <div class="paper-foot">
    <div class="paper-notes">
      ${doc.notes ? `<div class="paper-label">${esc(tr('notes'))}</div><div class="paper-sub">${multiline(doc.notes)}</div>` : ''}
      ${payInstructions ? `<div class="paper-label">${esc(tr('paymentDetails'))}</div><div class="paper-sub">${multiline(payInstructions)}</div>` : ''}
      ${taxNote ? `<div class="paper-label">${esc(tr('taxNoteLabel'))}</div><div class="paper-sub">${multiline(taxNote)}</div>` : ''}
      ${lateFee ? `<div class="paper-label">${esc(tr('lateFee'))}</div><div class="paper-sub">${esc(lateFee)}</div>` : ''}
      ${payLink && isInvoice && t.balance > 0.005 ? `
        <div class="paper-label">${esc(tr('payOnline'))}</div>
        <a class="paper-paylink" href="${esc(payLink)}" rel="noopener"${tint('color', brand)}>${esc(payLink)}</a>` : ''}
    </div>
    <div class="paper-totals">${totals}${schedule}</div>
  </div>`;
}

/**
 * A statement of account: every invoice still owed by one client, on one
 * page. The document slow-paying clients ask for ("send me everything I owe
 * in one place"), rendered by the same paper as the invoices it lists.
 *
 * `docs` are the client's open invoices; totals are kept per currency, and a
 * client billed in two currencies gets a total line for each.
 */
export function statementHTML(client, docs, settings, { today = null } = {}) {
  const lang = docLang(null, client);
  const tr = translator(lang);
  const brand = brandColorOf(settings);
  const asOf = today || '';
  const rows = [...docs].sort((a, b) => (a.issueDate < b.issueDate ? -1 : a.issueDate > b.issueDate ? 1 : 0));

  const due = {};
  const overdue = {};
  // On an invoice split into installments the date that matters is the
  // earliest one still open, exactly as the status derivation reads it.
  const dueOn = new Map(rows.map((doc) => [doc, dueDateFor(doc)]));
  for (const doc of rows) {
    const { balance } = docTotals(doc);
    due[doc.currency] = round2((due[doc.currency] || 0) + balance);
    // Only the part that is actually late: on a payment plan the half due
    // next month is not overdue because the half due last month is, and a
    // statement telling the client otherwise is one they would dispute.
    const late = asOf ? overdueAmount(doc, asOf) : 0;
    if (late > 0.005) overdue[doc.currency] = round2((overdue[doc.currency] || 0) + late);
  }
  const multi = Object.keys(due).length > 1;

  const body = rows.map((doc) => {
    const t = docTotals(doc);
    const on = dueOn.get(doc);
    const late = asOf && on && on < asOf;
    return `
    <tr>
      <td>${esc(doc.number)}</td>
      <td>${fmtDateSafe(doc.issueDate, lang)}</td>
      <td>${on ? fmtDateSafe(on, lang) : esc(tr('onReceipt'))}${late ? ` <span class="paper-late">${esc(tr('overdueFlag'))}</span>` : ''}</td>
      <td class="num">${fmtMoney(t.total, doc.currency)}</td>
      <td class="num">${fmtMoney(t.balance, doc.currency)}</td>
    </tr>`;
  }).join('');

  // How old the money is, under the totals it adds up to — the one thing a
  // slow-paying client reads before deciding what to pay first. Only when
  // `asOf` is known: without a date, "60 days overdue" means nothing.
  const aged = asOf ? aging(rows, [], {
    asOf,
    // Every invoice on the statement is aged, however it is dated: the
    // breakdown sits under a total that already counts all of them.
    issuedThrough: ANY_ISSUE_DATE,
  }) : { currencies: [], totals: {} };
  const ageRows = statementAgingRows(aged, tr, { multi });

  const totals = [
    ...Object.entries(due).map(([currency, amount]) =>
      [`${tr('totalDue')}${multi ? ` (${esc(currency)})` : ''}`, amount, currency, true]),
    ...Object.entries(overdue).map(([currency, amount]) =>
      [`${tr('ofWhichOverdue')}${multi ? ` (${esc(currency)})` : ''}`, amount, currency, false]),
  ].map(([label, amount, currency, strong]) => `
    <div class="paper-trow${strong ? ' strong' : ''}"${strong ? tint('border-top-color', brand) : ''}>
      <span>${label}</span>
      <span class="num">${fmtMoney(amount, currency)}</span>
    </div>`).join('');

  return `
  <div class="paper-head">
    ${bizBlock(settings, tr)}
    <div class="paper-id">
      <div class="paper-kind"${tint('color', brand)}>${esc(tr('statement'))}</div>
      ${asOf ? `<div class="paper-sub">${esc(tr('asOf'))} ${fmtDateSafe(asOf, lang)}</div>` : ''}
    </div>
  </div>
  <div class="paper-parties">
    <div>
      <div class="paper-label">${esc(tr('accountOf'))}</div>
      ${clientBlock(client, tr)}
    </div>
    <div class="paper-dates">
      <div class="paper-label">${esc(tr('openInvoices'))}</div>
      <div>${rows.length}</div>
    </div>
  </div>
  <div class="paper-table-scroll" tabindex="0" role="region" aria-label="${esc(tr('openInvoices'))}">
  <table class="paper-table paper-table-statement">
    <thead>
      <tr>${[[tr('invoice'), ''], [tr('issued'), ''], [tr('due'), ''], [tr('amount'), ' class="num"'], [tr('balance'), ' class="num"']]
    .map(([label, cls]) => `<th scope="col"${cls}${tint('border-bottom-color', brand)}>${esc(label)}</th>`).join('')}</tr>
    </thead>
    <tbody>${body || `<tr><td colspan="5" class="paper-sub">${esc(tr('nothingOutstanding'))}</td></tr>`}</tbody>
  </table>
  </div>
  <div class="paper-foot">
    <div class="paper-notes">
      ${settings.defaultNotes ? `<div class="paper-label">${esc(tr('notes'))}</div>
      <div class="paper-sub">${multiline(settings.defaultNotes)}</div>` : ''}
    </div>
    <div class="paper-totals">${totals}${ageRows.length ? `
      <div class="paper-aging">
        <div class="paper-label">${esc(tr('agingTitle'))}</div>
        ${ageRows.map(([label, amount, currency]) => `
        <div class="paper-trow">
          <span>${esc(label)}</span>
          <span class="num">${fmtMoney(amount, currency)}</span>
        </div>`).join('')}
      </div>` : ''}</div>
  </div>`;
}

/**
 * A receipt for one entry on an invoice: money received, or money sent back.
 * A refund prints as its own "Refund receipt" with a positive amount, because
 * a client reading "-$250.00 refunded" has to do a double take.
 */
export function receiptHTML(payment, doc, client, settings) {
  const t = docTotals(doc);
  const lang = docLang(doc, client);
  const tr = translator(lang);
  const brand = brandColorOf(settings);
  const refund = isRefund(payment);
  return `
  <div class="paper-head">
    ${bizBlock(settings, tr)}
    <div class="paper-id">
      <div class="paper-kind"${tint('color', brand)}>${esc(tr(refund ? 'refundReceipt' : 'receipt'))}</div>
      <div class="paper-number">${esc(payment.number || '')}</div>
    </div>
  </div>
  <div class="paper-parties">
    <div>
      <div class="paper-label">${esc(tr(refund ? 'refundedTo' : 'receivedFrom'))}</div>
      ${clientBlock(client, tr)}
    </div>
    <div class="paper-dates">
      <div class="paper-label">${esc(tr('date'))}</div>
      <div>${fmtDateSafe(payment.date, lang)}</div>
      <div class="paper-label">${esc(tr('for'))}</div>
      <div>${esc(doc.number)}</div>
    </div>
  </div>
  <div class="receipt-amount">
    <div class="paper-label">${esc(tr(refund ? 'amountRefunded' : 'amountReceived'))}</div>
    <div class="receipt-big">${fmtMoney(Math.abs(Number(payment.amount) || 0), doc.currency)}</div>
    ${payment.method ? `<div class="paper-sub">${esc(tr('via'))} ${esc(payment.method)}</div>` : ''}
    ${payment.note ? `<div class="paper-sub">${multiline(payment.note)}</div>` : ''}
  </div>
  <div class="paper-totals" style="margin-inline-start:auto">
    <div class="paper-trow"><span>${esc(tr('invoiceTotal'))}</span><span class="num">${fmtMoney(t.total, doc.currency)}</span></div>
    <div class="paper-trow"><span>${esc(tr('paidToDate'))}</span><span class="num">${fmtMoney(t.paid, doc.currency)}</span></div>
    <div class="paper-trow strong"${tint('border-top-color', brand)}><span>${esc(tr('balance'))}</span><span class="num">${fmtMoney(t.balance, doc.currency)}</span></div>
  </div>`;
}
