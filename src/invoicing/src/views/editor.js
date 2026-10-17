/**
 * Document editor: invoices, estimates, and recurring templates share one
 * form; only the scheduling / due-date row differs. Full view rather than
 * a modal, because line items need room.
 */

import { el, clear, append } from '../ui/dom.js';
import { icon } from '../ui/icons.js';
import { toast } from '../ui/toast.js';
import { field, selectWrap, emptyState, taxNoteControl } from '../ui/bits.js';
import { store } from '../lib/store.js';
import { uid, clamp } from '../lib/util.js';
import {
  todayISO, addDays, addMonthsClamped, daysBetween, fmtDate, FREQUENCIES,
  issuedCount, remainingOccurrences, ruleCompleted, isISODate, MIN_DATE, MAX_DATE,
} from '../lib/dates.js';
import {
  CURRENCIES, UNIT_SUGGESTIONS, docTotals, docTaxes, fmtMoney, lineTotal, inBase,
} from '../lib/money.js';
import { billingDefaults, copyItems, defaultTaxes, settingsTaxes, termDays } from '../lib/doc.js';
import { LANGS, docLang, translator } from '../lib/i18n.js';
import { chargesUntaxed, taxNoteText, taxNoteValue } from '../lib/taxnote.js';
import { republishIfShared } from '../lib/share.js';
import { openClientForm } from './clients.js';
import { openLineImport } from '../ui/line-import.js';

export function editorView({ navigate, params }) {
  const root = el('div.view');
  const today = todayISO();

  /* ----- Resolve what is being edited ----- */
  let mode; // 'new-doc' | 'edit-doc' | 'new-rule' | 'edit-rule'
  let source = null;
  if (params.id) {
    source = store.doc(params.id);
    mode = 'edit-doc';
  } else if (params.recurringId) {
    source = store.recurring.find((r) => r.id === params.recurringId) || null;
    mode = 'edit-rule';
  } else {
    mode = params.kind === 'recurring' ? 'new-rule' : 'new-doc';
  }
  if ((mode === 'edit-doc' || mode === 'edit-rule') && !source) {
    // A schedule is not a document, and a bare sentence is not a page: name
    // what is actually gone and offer the list it came from, the way a
    // missing client's page does.
    const goneRule = mode === 'edit-rule';
    root.append(
      el('div.page-head', {}, el('div', {},
        el('div.back-row', {},
          el('a.back-link', {
            href: goneRule ? '#/recurring' : '#/invoices',
            html: icon('back', 16, 1.8),
          }, goneRule ? ' Recurring' : ' Invoices')),
        el('h1.page-title', {}, goneRule ? 'Schedule not found' : 'Document not found'))),
      emptyState(goneRule ? 'repeat' : 'invoice',
        goneRule ? 'This schedule no longer exists' : 'This document no longer exists',
        goneRule
          ? 'It may have been deleted. Invoices it already drafted stay in your records.'
          : 'It may have been deleted. Nothing else in your records changed.')
    );
    return root;
  }

  // Nothing here can be saved from a device showing a saved copy, and a form
  // that cannot be submitted is worse than a page that says so.
  if (store.readOnly) {
    root.append(
      el('div.page-head', {}, el('div', {},
        el('div.back-row', {},
          el('a.back-link', { href: '#/invoices', html: icon('back', 16, 1.8) }, ' Invoices')),
        el('h1.page-title', {}, 'Offline'))),
      emptyState('wifiOff', 'This device is showing a saved copy',
        'Documents can be read, printed, and downloaded as PDFs while you are offline. '
        + 'Creating and editing need a connection to your cloud.')
    );
    return root;
  }

  const isRule = mode === 'new-rule' || mode === 'edit-rule';
  const kind = isRule ? 'invoice' : (source?.kind || params.kind || 'invoice');
  const isInvoice = kind === 'invoice';
  const s = store.settings;

  /* ----- Working draft ----- */
  // A new document starts from the global defaults with the preselected
  // client's overrides applied, so billing Acme in EUR on 30-day terms takes
  // no adjustment at all.
  const isNew = mode === 'new-doc' || mode === 'new-rule';
  // "Start from the last one": a new document seeded from an existing one's
  // contents, dated today, its deadline recomputed from the client's terms.
  // Unlike Duplicate on a document's page, nothing exists until Create is
  // pressed — backing out costs nothing, not even a reserved number. A
  // `from` that no longer resolves (deleted, or the other kind) just starts
  // the blank form it always did.
  const fromDoc = isNew && !isRule && params.from ? store.doc(params.from) : null;
  const copyFrom = fromDoc && fromDoc.kind === kind ? fromDoc : null;
  const startDefaults = billingDefaults(s,
    isNew ? store.client(params.client || copyFrom?.clientId) : null);
  // How far the copy's issue date moves; its payment plan shifts by the same
  // offset, exactly as store.duplicateDoc does, so "half on signing, half a
  // month later" keeps saying what it said.
  const copyShift = copyFrom && /^\d{4}-\d{2}-\d{2}$/.test(String(copyFrom.issueDate || ''))
    ? daysBetween(copyFrom.issueDate, today) : 0;
  const draft = source ? {
    ...source,
    // A description is the one field the form treats as a string throughout
    // (it is trimmed to validate, and again to save). Restored or legacy data
    // can carry a line with no `name` at all — the validator only requires an
    // object — and Save then threw before it could report anything, leaving
    // the editor a dead end with no toast and no way out but Cancel.
    items: (source.items || []).map((it) => ({ ...it, name: String(it.name ?? '') })),
    // Whatever shape the source stored (a taxes list, or just the legacy
    // single rate), the editor works on named rows; an unnamed legacy rate
    // takes the settings label it has always rendered with. Rates load
    // pinned to 0-100: a document saved before the inputs pinned can carry
    // 150, and the pin only fires on a change event an untouched field
    // never gets — the preview would compute 150% while Save stored 100.
    taxes: docTaxes(source).map((t) => ({
      label: t.label || s.taxLabel || 'TVA',
      rate: clamp(Number(t.rate) || 0, 0, 100),
    })),
    // The discount gets the same load-time pin, against the range its own
    // type allows.
    discountValue: clamp(Number(source.discountValue) || 0, 0,
      source.discountType === 'percent' ? 100 : Infinity),
    // The deposit is edited in place through its value input, and store.doc()
    // hands out the stored object by live reference: without a copy, typing a
    // value and cancelling would leave the change showing until reload.
    deposit: source.deposit ? { ...source.deposit } : source.deposit,
    // Same for the installment rows, which are edited in place.
    ...(Array.isArray(source.schedule)
      ? { schedule: source.schedule.map((r) => ({ ...r })) }
      : {}),
  } : {
    // Only a client the picker can show: the copy's client may have been
    // deleted since, and an id the select cannot name would ride along
    // unseen and re-attach when the client is restored.
    clientId: params.client || (store.client(copyFrom?.clientId) ? copyFrom.clientId : ''),
    currency: copyFrom?.currency || startDefaults.currency,
    // The copied lines get the same string-name guarantee the edit path
    // gives loaded data, and fresh copies of their mutable innards.
    items: copyFrom
      ? copyItems(copyFrom.items).map((it) => ({ ...it, name: String(it.name ?? '') }))
      : [{ id: uid(), name: '', qty: 1, rate: '' }],
    // The copy's taxes load exactly as the edit path loads them: named rows,
    // labels falling back, rates pinned to what Save would store.
    taxes: (copyFrom
      ? docTaxes(copyFrom).map((t) => ({
        label: t.label || s.taxLabel || 'TVA',
        rate: clamp(Number(t.rate) || 0, 0, 100),
      }))
      : defaultTaxes(s, isNew ? store.client(params.client) : null).map((t) => ({ ...t }))),
    taxInclusive: copyFrom ? !!copyFrom.taxInclusive : !!s.taxInclusive,
    discountType: copyFrom?.discountType || 'none',
    discountValue: copyFrom
      ? clamp(Number(copyFrom.discountValue) || 0, 0,
        copyFrom.discountType === 'percent' ? 100 : Infinity)
      : 0,
    notes: copyFrom ? (copyFrom.notes || '') : startDefaults.notes,
    ...(copyFrom?.deposit ? { deposit: { ...copyFrom.deposit } } : {}),
    ...(copyFrom && Array.isArray(copyFrom.schedule)
      ? {
        schedule: copyFrom.schedule.map((r) => ({
          ...r,
          ...(r?.dueDate && copyShift && /^\d{4}-\d{2}-\d{2}$/.test(String(r.dueDate))
            ? { dueDate: addDays(r.dueDate, copyShift) } : {}),
        })),
      }
      : {}),
    ...(isRule
      ? {
        name: '', freq: 'monthly', nextDue: today, paused: false,
        endMode: 'never', endDate: '', endCount: '',
      }
      : {
        // The reference travels like store.duplicateDoc carries it: the PO
        // usually belongs to the engagement the copy continues.
        reference: copyFrom?.reference || '',
        language: copyFrom?.language || s.defaultLanguage || 'fr',
        taxNote: copyFrom?.taxNote || '',
        ...(copyFrom && Number(copyFrom.fxRate) > 0 ? { fxRate: Number(copyFrom.fxRate) } : {}),
        issueDate: today,
        ...(isInvoice
          ? { dueDate: addDays(today, startDefaults.paymentTermsDays) }
          : { validUntil: addDays(today, termDays(s.quoteValidDays, 30)) }),
      }),
  };

  /**
   * Fields the user has changed by hand. Picking a client re-seeds only the
   * fields still untouched: switching client must never quietly rewrite a
   * rate, a date, or a note someone typed.
   */
  const touched = {
    currency: false, taxes: false, notes: false, dueDate: false, validUntil: false,
  };
  if (!draft.items.length) draft.items.push({ id: uid(), name: '', qty: 1, rate: '' });

  const backHash = mode === 'edit-doc' ? `#/doc/${source.id}`
    : isRule ? '#/recurring'
    : kind === 'quote' ? '#/quotes' : '#/invoices';

  const title = mode === 'edit-doc' ? `Edit ${source.number}`
    : mode === 'edit-rule' ? 'Edit recurring invoice'
    : mode === 'new-rule' ? 'New recurring invoice'
    : isInvoice ? 'New invoice' : 'New estimate';

  // The number preview follows the issue date: with a {YYYY} prefix or a
  // yearly counter, backdating a document into another year changes the
  // number it will be given.
  const numberPreview = mode === 'new-doc' || mode === 'new-rule'
    ? el('p.page-sub') : null;
  const renderNumberPreview = () => {
    if (!numberPreview) return;
    numberPreview.textContent = mode === 'new-rule'
      ? 'Each generated invoice gets the next invoice number'
      : `Will be numbered ${store.peekNumber(kind, draft.issueDate)}`;
  };
  renderNumberPreview();

  /* ----- Client picker ----- */
  const clientSelect = el('select.select', {
    'aria-label': 'Client',
    onchange: (e) => {
      draft.clientId = e.target.value;
      applyClientDefaults();
    },
  });
  function renderClientOptions() {
    clear(clientSelect);
    clientSelect.append(el('option', { value: '' }, 'No client selected'));
    // A client restored from a backup may carry no name at all — the
    // validator only requires an id. Sorting on a missing name threw here
    // and left the whole editor blank; the label falls back the same way
    // the clients grid and the paper do.
    const byName = [...store.clients]
      .sort((a, b) => String(a.name || '').localeCompare(String(b.name || '')));
    for (const c of byName) {
      const name = (c.name || '').trim();
      clientSelect.append(el('option', {
        value: c.id, selected: c.id === draft.clientId,
      }, c.company ? (name ? `${c.company} (${name})` : c.company) : (name || 'Client')));
    }
  }
  renderClientOptions();

  /* ----- Line items ----- */
  const itemsWrap = el('div.items-rows');
  const datalist = el('datalist', { id: 'item-suggestions' },
    store.itemSuggestions().map((it) => el('option', { value: it.name })));
  // What a line is billed in — hours, days, words. Free text with common
  // values suggested: the unit prints verbatim beside the quantity, so it is
  // the user's own word, never one this app translates.
  const unitList = el('datalist', { id: 'unit-suggestions' },
    UNIT_SUGGESTIONS.map((u) => el('option', { value: u })));

  /**
   * The tax treatments one line can pick from: the document's own taxes and
   * the named rates from Settings (that is where a reduced VAT rate or a
   * "GST only" choice comes from), deduplicated by label and rate.
   */
  function lineTaxChoices() {
    const out = [];
    const seen = new Set();
    for (const t of [...draft.taxes, ...settingsTaxes(s)]) {
      const label = String(t.label || '').trim();
      const rate = Number(t.rate) || 0;
      if (!(rate > 0)) continue;
      const key = `${label.toLowerCase()}|${rate}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push({ label, rate });
    }
    return out;
  }

  /** A compact per-line tax picker, or null when there is nothing to pick. */
  function lineTaxSelect(it, i, update) {
    const choices = lineTaxChoices();
    if (!choices.length && !Array.isArray(it.taxes)) return null;
    const matches = (c) => Array.isArray(it.taxes) && it.taxes.length === 1
      && String(it.taxes[0].label || '') === c.label && Number(it.taxes[0].rate) === c.rate;
    // A stored treatment the choices no longer offer (say, from a restored
    // backup) still has to show as what it is rather than silently reading
    // as something else.
    const custom = Array.isArray(it.taxes) && it.taxes.length > 0 && !choices.some(matches);
    return selectWrap(el('select.select.item-tax', {
      'aria-label': `Line ${i + 1} tax`,
      onchange: (e) => {
        const v = e.target.value;
        if (v === '') delete it.taxes;
        else if (v === 'none') it.taxes = [];
        else it.taxes = [{ ...choices[Number(v)] }];
        update();
      },
    },
      el('option', { value: '', selected: !Array.isArray(it.taxes) }, 'Document taxes'),
      el('option', { value: 'none', selected: Array.isArray(it.taxes) && !it.taxes.length }, 'No tax'),
      choices.map((c, ci) => el('option', { value: String(ci), selected: matches(c) },
        `${c.label || 'Tax'} (${c.rate}%) only`)),
      custom ? el('option', { value: 'custom', selected: true, disabled: true },
        it.taxes.map((t) => `${t.label || 'Tax'} (${t.rate}%)`).join(' + ')) : null));
  }

  function renderItems() {
    clear(itemsWrap);
    draft.items.forEach((it, i) => {
      const amount = el('span.item-amount', {}, it.rate === '' ? '' : fmtMoney(lineTotal(it), draft.currency));
      const update = () => {
        amount.textContent = fmtMoney(lineTotal(it), draft.currency);
        renderTotals();
      };
      // The line's own tax picker is rebuilt in place when a saved item
      // brings a treatment with it: re-rendering the whole row would pull
      // the description input out from under the person typing in it.
      const nameCell = el('div.item-name-cell');
      const refreshTaxPicker = () => {
        const shown = nameCell.querySelector('.select-wrap');
        const next = lineTaxSelect(it, i, update);
        if (shown && next) shown.replaceWith(next);
        else if (next) nameCell.append(next);
        else shown?.remove();
      };
      // The line's own work description — the timekeeper or task keeps the
      // name, and what the hours were actually spent on prints under it.
      // A quiet toggle until a line needs one, so an invoice of plain lines
      // never grows a second box per row; once opened (even empty) the box
      // survives re-renders, and Save drops the blanks.
      const detailsBox = () => el('textarea.textarea.item-details', {
        rows: 2, value: it.details || '',
        placeholder: 'What the work was — prints under the description',
        'aria-label': `Line ${i + 1} work description`,
        oninput: (e) => { it.details = e.target.value; },
      });
      const detailsNode = () => {
        if (it.details !== undefined && it.details !== null) return detailsBox();
        return el('button.item-details-toggle', {
          type: 'button',
          'aria-label': `Add a work description to line ${i + 1}`,
          onclick: (e) => {
            it.details = '';
            const box = detailsBox();
            e.currentTarget.replaceWith(box);
            box.focus();
          },
        }, '+ Work description');
      };
      itemsWrap.append(el('div.item-row', {},
        append(nameCell, [
          el('input.input.item-name', {
            value: it.name, placeholder: 'Description',
            'aria-label': `Line ${i + 1} description`,
            list: 'item-suggestions',
            oninput: (e) => {
              it.name = e.target.value;
              const match = store.itemSuggestions().find((sug) => sug.name === it.name);
              if (!match) return;
              // Picking a saved item fills what the price list knows about
              // it — rate, unit, and its tax treatment — without ever
              // overwriting something already typed on this line.
              const row = e.target.closest('.item-row');
              let filled = false;
              if (it.rate === '' || Number(it.rate) === 0) {
                it.rate = match.rate;
                row.querySelector('.item-rate').value = match.rate;
                filled = true;
              }
              if (match.unit && !String(it.unit || '').trim()) {
                it.unit = match.unit;
                row.querySelector('.item-unit').value = match.unit;
                filled = true;
              }
              if (Array.isArray(match.taxes) && !Array.isArray(it.taxes)) {
                it.taxes = match.taxes.map((t) => ({ ...t }));
                refreshTaxPicker();
                filled = true;
              }
              if (filled) update();
            },
          }),
          detailsNode(),
          lineTaxSelect(it, i, update)]),
        // Narrow screens stack the row and cannot show .item-head, which
        // left two bare number boxes under the description. The inputs
        // carry their own aria-labels, so these are for the eye only.
        el('span.item-col-label.item-qty-label', { 'aria-hidden': 'true' }, 'Qty / unit'),
        el('span.item-col-label.item-rate-label', { 'aria-hidden': 'true' }, 'Rate'),
        el('div.item-qty-cell', {},
          el('input.input.item-qty', {
            type: 'number', min: '0', step: 'any', value: it.qty,
            'aria-label': `Line ${i + 1} quantity`, inputmode: 'decimal',
            oninput: (e) => { it.qty = e.target.value; update(); },
          }),
          el('input.input.item-unit', {
            value: it.unit || '', placeholder: 'unit',
            'aria-label': `Line ${i + 1} unit`,
            list: 'unit-suggestions', maxlength: '24',
            oninput: (e) => { it.unit = e.target.value; update(); },
          })),
        el('input.input.item-rate', {
          type: 'number', min: '0', step: 'any', value: it.rate, placeholder: '0.00',
          'aria-label': `Line ${i + 1} rate`, inputmode: 'decimal',
          oninput: (e) => { it.rate = e.target.value; update(); },
        }),
        amount,
        el('button.icon-btn.item-remove', {
          type: 'button', html: icon('x', 17, 1.6),
          'aria-label': `Remove line ${i + 1}`,
          disabled: draft.items.length === 1,
          onclick: () => {
            draft.items.splice(i, 1);
            renderItems();
            renderTotals();
            // The re-render destroyed the pressed button; hand focus to the
            // row that took this one's place so keyboard flow continues here.
            const rows = itemsWrap.querySelectorAll('.item-row');
            rows[Math.min(i, rows.length - 1)]?.querySelector('input')?.focus();
          },
        })
      ));
    });
  }

  /* ----- Totals ----- */
  const totalsWrap = el('div.editor-totals', { 'aria-live': 'polite' });
  function renderTotals() {
    renderTaxNotePreview();
    refreshScheduleAmounts();
    renderFxNote();
    clear(totalsWrap);
    const t = docTotals(draft);
    const row = (label, v, strong = false) =>
      el(`div.paper-trow${strong ? '.strong' : ''}`, {},
        el('span', {}, label), el('span.num', {}, fmtMoney(v, draft.currency)));
    // Sign-blind, like the Paid row: a credit line taxed on its own nets a
    // negative row, and dropping it left Subtotal and Total not adding up.
    const taxRows = t.taxes.filter((x) => Math.abs(x.amount) > 0.005);
    totalsWrap.append(row('Subtotal', t.subtotal));
    if (t.discount > 0) totalsWrap.append(row('Discount', -t.discount));
    if (!draft.taxInclusive) for (const x of taxRows) totalsWrap.append(row(`${x.label || 'Tax'} (${x.rate}%)`, x.amount));
    totalsWrap.append(row('Total', t.total, true));
    if (draft.taxInclusive) for (const x of taxRows) totalsWrap.append(row(`Includes ${x.label || 'Tax'} (${x.rate}%)`, x.amount));
    if (t.deposit > 0 && Math.abs(t.paid) <= 0.005) {
      totalsWrap.append(row(`Deposit due${draft.deposit?.type === 'percent' ? ` (${draft.deposit.value}%)` : ''}`, t.deposit, true));
    }
  }

  /* ----- Extras (discount, tax) ----- */
  // Pinned to its usable range when the field is left, like the tax rate
  // below: the totals already refuse a negative or over-100% discount, but
  // the raw value would still be saved — and the paper prints it in the
  // "Discount (150%)" label right beside an amount it does not match.
  const pinDiscount = () => {
    if (discountValueInput.value === '') return;
    const max = draft.discountType === 'percent' ? 100 : Infinity;
    const pinned = clamp(Number(discountValueInput.value) || 0, 0, max);
    discountValueInput.value = pinned;
    draft.discountValue = pinned;
    renderTotals();
  };
  const discountValueInput = el('input.input', {
    type: 'number', min: '0', step: 'any',
    value: draft.discountValue || '',
    'aria-label': 'Discount value',
    disabled: draft.discountType === 'none',
    oninput: (e) => { draft.discountValue = e.target.value; renderTotals(); },
    onchange: pinDiscount,
  });
  const discountSelect = el('select.select', {
    'aria-label': 'Discount type',
    onchange: (e) => {
      draft.discountType = e.target.value;
      discountValueInput.disabled = draft.discountType === 'none';
      if (draft.discountType === 'none') { draft.discountValue = 0; discountValueInput.value = ''; }
      // A fixed amount that made sense (say 150) is out of range as a
      // percentage; switching the type re-pins the value it applies to.
      else pinDiscount();
      renderTotals();
    },
  },
    el('option', { value: 'none', selected: draft.discountType === 'none' }, 'No discount'),
    el('option', { value: 'percent', selected: draft.discountType === 'percent' }, 'Percent (%)'),
    el('option', { value: 'fixed', selected: draft.discountType === 'fixed' }, 'Fixed amount'));

  /* ----- Deposit (the part asked for up front) ----- */
  // Same control pair and pinning as the discount above; the totals clamp a
  // fixed deposit to the total, but the paper prints the typed percentage in
  // its "Deposit due (n%)" label, so the field must hold what applies.
  const pinDeposit = () => {
    if (!draft.deposit || depositValueInput.value === '') return;
    const max = draft.deposit.type === 'percent' ? 100 : Infinity;
    const pinned = clamp(Number(depositValueInput.value) || 0, 0, max);
    depositValueInput.value = pinned;
    draft.deposit.value = pinned;
    renderTotals();
  };
  const depositValueInput = el('input.input', {
    type: 'number', min: '0', step: 'any',
    value: draft.deposit?.value || '',
    'aria-label': 'Deposit value',
    disabled: !draft.deposit,
    oninput: (e) => {
      if (!draft.deposit) return;
      draft.deposit.value = e.target.value;
      renderTotals();
    },
    onchange: pinDeposit,
  });
  const depositSelect = el('select.select', {
    'aria-label': 'Deposit type',
    onchange: (e) => {
      if (e.target.value === 'none') {
        draft.deposit = null;
        depositValueInput.disabled = true;
        depositValueInput.value = '';
      } else {
        draft.deposit = { type: e.target.value, value: depositValueInput.value };
        depositValueInput.disabled = false;
        pinDeposit();
      }
      // A deposit and a schedule ask for the same money twice; picking one
      // closes the other.
      renderSchedule();
      renderTotals();
    },
  },
    el('option', { value: 'none', selected: !draft.deposit }, 'No deposit'),
    el('option', { value: 'percent', selected: draft.deposit?.type === 'percent' }, 'Percent (%)'),
    el('option', { value: 'fixed', selected: draft.deposit?.type === 'fixed' }, 'Fixed amount'));

  // Built here rather than inline in the layout, because its caption has to
  // change: a payment schedule switches the deposit off, and the caption is
  // where that gets said.
  const depositField = isRule ? null
    : field('Deposit', el('div.duo', {}, selectWrap(depositSelect), depositValueInput),
      { hint: 'asked for up front' });
  const depositHint = depositField?.querySelector('.field-hint');

  /* ----- Payment schedule (the total, split over dates) ----- */
  // A deposit and a schedule are two ways of asking for part of the money up
  // front, so a document carries one or the other: adding the first
  // installment clears the deposit, and a deposit locks the Add button.
  const scheduleWrap = el('div.schedule-rows');
  const scheduleNote = el('p.card-sub.schedule-note', { 'aria-live': 'polite' });
  const hasSchedule = () => Array.isArray(draft.schedule) && draft.schedule.length > 0;

  function renderScheduleNote() {
    const rows = docTotals(draft).installments;
    if (!rows.length) {
      scheduleNote.textContent = draft.deposit
        ? 'A deposit is already asking for part of this up front. Clear it to split the total into installments instead.'
        : 'Split the total into parts with their own due dates — 50% on signing, 50% on delivery. The invoice is overdue as soon as the earliest unpaid part is.';
      return;
    }
    const sum = rows.reduce((a, r) => a + r.amount, 0);
    const t = docTotals(draft);
    scheduleNote.textContent = `${rows.length} installment${rows.length === 1 ? '' : 's'} · `
      + `${fmtMoney(sum, draft.currency)} of ${fmtMoney(t.total, draft.currency)}`
      + ' · the last row always takes what is left, including any rounding.';
  }

  /**
   * Repaint the derived figures: each row's own share, and the note under
   * them. Called whenever a row changes and whenever the total does, because
   * a percentage of a total that just moved is a different amount.
   */
  function refreshScheduleAmounts() {
    if (!scheduleWrap.isConnected && !scheduleWrap.children.length) return;
    const rows = docTotals(draft).installments;
    for (const node of scheduleWrap.querySelectorAll('.schedule-row')) {
      const derived = rows.find((a) => a.id === node.dataset.row);
      const cell = node.querySelector('.item-amount');
      if (cell) cell.textContent = derived ? fmtMoney(derived.amount, draft.currency) : '';
    }
    renderScheduleNote();
  }

  function renderScheduleRows() {
    clear(scheduleWrap);
    const amounts = docTotals(draft).installments;
    (draft.schedule || []).forEach((row, i) => {
      // The derived amount for this row, matched by id: the rows are shown
      // in the order they were typed, while the amounts come back in date
      // order, and pairing them by position would print the wrong figure.
      const derived = amounts.find((a) => a.id === row.id);
      const amount = el('span.item-amount', {},
        derived ? fmtMoney(derived.amount, draft.currency) : '');
      // Every row's share moves when any one of them changes — and when a
      // line item does — so the refresher below repaints all of them.
      const update = () => refreshScheduleAmounts();
      const valueInput = el('input.input.schedule-value', {
        type: 'number', min: '0', step: 'any', inputmode: 'decimal',
        value: row.value ?? '', placeholder: '0',
        'aria-label': `Installment ${i + 1} value`,
        oninput: (e) => { row.value = e.target.value; update(); },
        onchange: () => { pinValue(); update(); },
      });
      // What Save will store, shown in the box: a percentage is pinned to
      // 0-100, a fixed amount to zero or more. Blank stays blank.
      const pinValue = () => {
        if (valueInput.value === '') return;
        const pinned = clamp(Number(valueInput.value) || 0, 0, row.type === 'fixed' ? Infinity : 100);
        valueInput.value = pinned;
        row.value = pinned;
      };
      scheduleWrap.append(el('div.schedule-row', { dataset: { row: row.id } },
        el('input.input.schedule-label', {
          value: row.label || '', placeholder: 'On signing, On delivery…',
          'aria-label': `Installment ${i + 1} description`,
          oninput: (e) => { row.label = e.target.value; },
        }),
        el('input.input.schedule-date', {
          type: 'date', value: row.dueDate || '', min: MIN_DATE, max: MAX_DATE,
          'aria-label': `Installment ${i + 1} due date`,
          onchange: (e) => {
            // A cleared date has no reading of its own here: the row would
            // silently sort behind the others and be measured against the
            // invoice's own date instead. A year of five digits goes back
            // too, like every other date on the form (see dateInput).
            if (!acceptDate(e.target)) {
              e.target.value = row.dueDate || '';
              return;
            }
            row.dueDate = e.target.value;
            update();
          },
        }),
        selectWrap(el('select.select.schedule-type', {
          'aria-label': `Installment ${i + 1} type`,
          onchange: (e) => {
            row.type = e.target.value;
            // The range moved with the type: a fixed 500 switched back to a
            // percentage is over 100, and Save would clamp it in silence
            // while the box kept showing 500 (the discount and deposit
            // pickers re-pin the same way).
            pinValue();
            update();
          },
        },
          el('option', { value: 'percent', selected: row.type !== 'fixed' }, '%'),
          el('option', { value: 'fixed', selected: row.type === 'fixed' }, draft.currency))),
        valueInput,
        amount,
        el('button.icon-btn.item-remove', {
          type: 'button', html: icon('x', 17, 1.6),
          'aria-label': `Remove installment ${i + 1}`,
          onclick: () => {
            draft.schedule.splice(i, 1);
            if (!draft.schedule.length) delete draft.schedule;
            renderSchedule();
            renderTotals();
            // The re-render destroyed the pressed button: stay among the
            // rows, or land on Add installment once none are left.
            const removes = scheduleWrap.querySelectorAll('.item-remove');
            (removes[Math.min(i, removes.length - 1)]
              || scheduleWrap.querySelector('.add-line'))?.focus();
          },
        })));
    });
    scheduleWrap.append(el('button.btn.btn-ghost.add-line', {
      type: 'button', html: icon('plus', 15, 1.8),
      disabled: !!draft.deposit,
      onclick: () => {
        if (!Array.isArray(draft.schedule)) draft.schedule = [];
        const last = draft.schedule[draft.schedule.length - 1];
        draft.schedule.push({
          id: uid(),
          label: '',
          // Each new part falls a month after the one before it, counted
          // from the invoice's own due date for the first.
          dueDate: addMonthsClamped(last?.dueDate || draft.dueDate || draft.issueDate || today, 1),
          type: 'percent',
          value: draft.schedule.length ? '' : 50,
        });
        renderSchedule();
        renderTotals();
        scheduleWrap.querySelector('.schedule-row:last-of-type input')?.focus();
      },
    }, ' Add installment'));
  }

  function renderSchedule() {
    renderScheduleRows();
    renderScheduleNote();
    // A deposit and a schedule ask for the same money, so a document carries
    // one or the other — and a control that greys itself out says nothing
    // about why on its own. Adding the first installment used to switch the
    // Deposit picker off in silence; its caption now says what took it.
    const locked = hasSchedule();
    depositSelect.disabled = locked;
    if (depositHint) {
      depositHint.textContent = locked
        ? ' off while a payment schedule splits the total'
        : ' asked for up front';
    }
    for (const control of [depositSelect, depositValueInput]) {
      if (locked) control.title = 'A payment schedule is already splitting this total';
      else control.removeAttribute('title');
    }
    if (locked && draft.deposit) {
      draft.deposit = null;
      depositValueInput.value = '';
      depositValueInput.disabled = true;
      depositSelect.value = 'none';
    }
  }

  /* ----- Save ----- */
  /** A row that is not a blank to prune: it has a description, or money the
   *  on-screen total already includes, or words typed under a name it never
   *  got — dropping any of those would save a different document than the
   *  one on screen, or lose what was written. */
  const saysSomething = (it) => !!(it.name.trim() || lineTotal(it) !== 0 || String(it.details ?? '').trim());
  // One guard for both Save buttons (header and footer): without it, two
  // quick clicks reserve two numbers and create two documents.
  let saving = false;
  async function save() {
    if (saving) return;
    // Validate a cleaned copy; draft.items stays untouched so a failed
    // validation (or a failed write) never discards rows the user typed.
    const items = draft.items
      .map((it) => {
        const next = {
          ...it,
          name: it.name.trim(),
          qty: Number(it.qty) || 0,
          rate: Number(it.rate) || 0,
          // Display only, and the user's own word: trimmed and bounded, never
          // interpreted. An empty one is dropped, so a line without a unit
          // stores exactly what it always did.
          unit: String(it.unit ?? '').trim().slice(0, 24),
        };
        if (!next.unit) delete next.unit;
        // The work description is the user's own words too: trimmed, never
        // interpreted, and dropped when empty — a line without one stores
        // exactly what it always did.
        const details = String(it.details ?? '').trim();
        if (details) next.details = details;
        else delete next.details;
        if (Array.isArray(it.taxes)) next.taxes = cleanTaxes(it.taxes);
        return next;
      })
      .filter((it) => it.name);
    // A nameless row that still carries money, or a work description, is not
    // a blank to prune: the total includes the one and the user wrote the
    // other, and silently dropping either would save a different document
    // than the one on screen.
    const nameless = draft.items.findIndex((it) => !it.name.trim() && saysSomething(it));
    if (nameless >= 0) {
      toast(`Line ${nameless + 1} needs a description`, { icon: 'alert' });
      itemsWrap.querySelectorAll('.item-name')[nameless]?.focus();
      return;
    }
    if (!items.length) {
      toast('Add at least one line item', { icon: 'alert' });
      // There is always a row to land in: the draft is seeded with one and
      // the last row's remove button is disabled.
      itemsWrap.querySelector('.item-name')?.focus();
      return;
    }
    // Every date the form carries, checked once more where it is saved: the
    // fields above refuse a five-digit year as it is typed, but a document
    // loaded with one (the store took them before the fields did) has to be
    // corrected here rather than written back as it came. The date a
    // document is filed under is required; the others are checked only when
    // they hold something — an invoice with no due date is due on receipt,
    // which is a real term the paper prints, not a date to refuse.
    const badDate = [
      ...(isRule
        ? [[draft.nextDue || '', dateInputs.nextDue], [draft.endMode === 'date' ? draft.endDate : today, endDateInput]]
        : [[draft.issueDate || '', dateInputs.issueDate],
          [isInvoice ? draft.dueDate : draft.validUntil, isInvoice ? dateInputs.dueDate : dateInputs.validUntil]]),
      ...(hasSchedule() && isInvoice && !isRule
        ? draft.schedule.map((r, i) => [r.dueDate, scheduleWrap.querySelectorAll('.schedule-date')[i]])
        : []),
    ].find(([value], i) => (i === 0 ? !isISODate(value) : !!value && !isISODate(value)));
    if (badDate) {
      toast('Enter a year between 1000 and 9999', { icon: 'alert' });
      badDate[1]?.focus();
      return;
    }
    // An empty count has no "inherit" reading to fall back on: saving the
    // coerced 1 would cap — and on an edited rule, instantly complete — a
    // schedule the field shows as unbounded.
    if (isRule && draft.endMode === 'count' && String(draft.endCount ?? '').trim() === '') {
      toast('Enter how many invoices the schedule should draft', { icon: 'alert' });
      endCountInput.focus();
      return;
    }
    // Every installment but the last needs a share of its own: the last row
    // takes whatever is left, but a blank one before it silently asks for
    // nothing while the form shows a row that looks meaningful.
    if (hasSchedule()) {
      const order = docTotals(draft).installments;
      const lastId = order[order.length - 1]?.id;
      const blank = draft.schedule.findIndex((r) => r.id !== lastId
        && String(r.value ?? '').trim() === '');
      if (blank >= 0) {
        toast(`Say what installment ${blank + 1} asks for`, { icon: 'alert' });
        scheduleWrap.querySelectorAll('.schedule-value')[blank]?.focus();
        return;
      }
      const undated = draft.schedule.findIndex((r) => !r.dueDate);
      if (undated >= 0) {
        toast(`Give installment ${undated + 1} a due date`, { icon: 'alert' });
        scheduleWrap.querySelectorAll('.schedule-date')[undated]?.focus();
        return;
      }
    }
    // A chosen "Custom wording" with an empty box is content Save would drop
    // while the form kept showing it.
    const note = isRule ? { value: '' } : taxNote.read();
    if (note.error) {
      toast(note.error, { icon: 'alert' });
      note.focus.focus();
      return;
    }
    draft.taxNote = note.value;
    // A labelled tax row without a positive rate is content Save would
    // silently drop while the form kept showing it — the same state the
    // Settings defaults card refuses for the same reason.
    const badTax = draft.taxes.findIndex((t) => (t.label || '').trim()
      && !(clamp(Number(t.rate) || 0, 0, 100) > 0));
    if (badTax >= 0) {
      toast(`Give “${draft.taxes[badTax].label.trim()}” a rate above zero, or remove it`, { icon: 'alert' });
      taxesWrap.querySelectorAll('.tax-row input[type="number"]')[badTax]?.focus();
      return;
    }
    // The same tax twice is one tax: the totals count it once, so a second
    // identical row is content the paper would never show. Refused rather
    // than quietly dropped, like the rate-less row above.
    const dupTax = duplicateTaxIndex(draft.taxes);
    if (dupTax >= 0) {
      toast(`“${(draft.taxes[dupTax].label || 'Tax').trim()}” at ${Number(draft.taxes[dupTax].rate)}% is already listed`, { icon: 'alert' });
      taxesWrap.querySelectorAll('.tax-row input:not([type="number"])')[dupTax]?.focus();
      return;
    }
    saving = true;
    // The whole action row waits with the write: a Cancel that still works
    // mid-save walks off to another view that the save's own navigation
    // would then tear down.
    const actions = root.querySelectorAll('.page-actions .btn, .editor-footer .btn');
    // Disabling the pressed button drops keyboard focus to <body>; remember
    // it so the failure path can hand focus back for another try.
    const pressed = [...actions].includes(document.activeElement) ? document.activeElement : null;
    for (const b of actions) b.disabled = true;
    try {
      if (isRule) {
        const client = store.client(draft.clientId);
        const rule = {
          id: source?.id || uid(),
          name: draft.name?.trim()
            || (client ? `${client.company || client.name} · ${fmtMoney(docTotals({ ...draft, items }).total, draft.currency)}` : 'Recurring invoice'),
          clientId: draft.clientId || '',
          currency: draft.currency,
          items,
          taxes: cleanTaxes(draft.taxes),
          taxInclusive: !!draft.taxInclusive,
          discountType: draft.discountType,
          discountValue: Number(draft.discountValue) || 0,
          notes: draft.notes || '',
          freq: draft.freq,
          anchorDay: ruleAnchorDay(),
          nextDue: draft.nextDue,
          paused: !!draft.paused,
          endMode: draft.endMode || 'never',
          endDate: draft.endMode === 'date' ? draft.endDate : '',
          endCount: draft.endMode === 'count' ? Math.max(1, Math.round(Number(draft.endCount) || 1)) : '',
          // A cap counts what this schedule has drafted, so a rule that
          // predates end conditions starts from the invoices it already made.
          issued: source?.issued ?? alreadyIssued,
          createdAt: source?.createdAt || Date.now(),
        };
        await store.saveRecurring(rule);
        toast(mode === 'edit-rule' ? 'Recurring invoice updated' : 'Recurring invoice scheduled', { icon: 'repeat' });
        // A schedule dated today (or backdated) should act now, not at the
        // next reload; boot is the only other place that generates.
        if (!rule.paused && !ruleCompleted(rule) && rule.nextDue && rule.nextDue <= todayISO()) {
          const n = await store.processRecurringDue().catch(() => 0);
          if (n) toast(`${n} invoice${n === 1 ? '' : 's'} drafted from the schedule`, { icon: 'repeat' });
        }
        // Only steer a user who is still here: if they left during the
        // write, yanking them off the view they moved on to (and tearing
        // down whatever they typed there) is worse than staying put.
        if (root.isConnected) navigate('#/recurring');
        return;
      }

      let doc;
      if (mode === 'new-doc') {
        // Snapshot the form before the number reservation's network wait:
        // only the action buttons are disabled while it runs, so edits made
        // in the meantime would otherwise land in the saved document
        // piecemeal — and an issue-date correction during the wait would
        // break the agreement between the reserved number's year and the
        // date the document carries.
        const fields = draftFields(items);
        const number = await store.reserveNumber(kind, fields.issueDate);
        doc = {
          id: uid(),
          kind,
          number,
          status: 'draft',
          payments: [],
          createdAt: Date.now(),
          ...fields,
        };
      } else {
        // Onto the document as the store holds it now, not as it stood when
        // this form opened. The form owns only the fields it edits
        // (draftFields); everything else — the share token, the attachment
        // records, the payments — is whatever the document carries by the
        // time Save lands. Written back from the opening snapshot, a publish
        // that was still in the air when Edit was pressed recorded its token
        // seconds after the form had read the document, and Save then dropped
        // it: the page stayed live under a token nothing recorded, with no
        // card left to take it down. A file still uploading lost its record
        // the same way.
        doc = { ...(store.doc(source.id) || source), ...draftFields(items) };
      }
      await store.saveDoc(doc);
      // Keep an already-shared page in step with what was just saved.
      republishIfShared(store, doc.id)
        .catch(() => toast('Could not refresh the shared page', { icon: 'wifiOff' }));
      toast(mode === 'new-doc' ? `${doc.number} created` : 'Saved');
      if (root.isConnected) navigate(`#/doc/${doc.id}`);
    } catch (err) {
      console.error(err);
      toast('Could not save. Check your connection', { icon: 'wifiOff' });
      saving = false;
      for (const b of actions) b.disabled = false;
      if (pressed && document.activeElement === document.body) pressed.focus();
    }
  }

  /** The position of the first tax row that repeats an earlier one's label
   *  and rate, or -1. Blank rows (no rate) are not compared: Save drops them. */
  function duplicateTaxIndex(list) {
    const key = (t) => `${(t.label || '').trim()}|${clamp(Number(t.rate) || 0, 0, 100)}`;
    return (list || []).findIndex((t, i) => clamp(Number(t.rate) || 0, 0, 100) > 0
      && list.slice(0, i).some((u) => clamp(Number(u.rate) || 0, 0, 100) > 0 && key(u) === key(t)));
  }

  /** Tax rows as they are stored: trimmed labels, pinned rates, no blanks. */
  function cleanTaxes(list) {
    return (list || [])
      .map((t) => ({ label: (t.label || '').trim(), rate: clamp(Number(t.rate) || 0, 0, 100) }))
      .filter((t) => t.rate > 0);
  }

  function draftFields(items) {
    return {
      clientId: draft.clientId || '',
      issueDate: draft.issueDate,
      ...(isInvoice ? { dueDate: draft.dueDate } : { validUntil: draft.validUntil }),
      reference: (draft.reference || '').trim(),
      language: draft.language || '',
      // '' follows the client, then Settings; 'none' is this document saying
      // it carries no such sentence whatever they say.
      taxNote: draft.taxNote || '',
      currency: draft.currency,
      // Absent means "not converted", never a guessed 1: a document in the
      // account's own currency needs no rate, and one billed abroad without
      // a rate is excluded from consolidated figures and counted out loud.
      ...(draft.currency !== baseCurrency() && Number(draft.fxRate) > 0
        ? { fxRate: Number(draft.fxRate) }
        : { fxRate: null }),
      items,
      // The named list is what totals read; an explicit empty list means "no
      // tax" even on a document that still carries its old single taxRate.
      taxes: cleanTaxes(draft.taxes),
      taxInclusive: !!draft.taxInclusive,
      discountType: draft.discountType,
      // Pinned like the deposit below: the paper prints the percent inside
      // the discount row's label, so a stored 150% would advertise a
      // discount the clamped amount never gives.
      discountValue: clamp(Number(draft.discountValue) || 0, 0,
        draft.discountType === 'percent' ? 100 : Infinity),
      // Null clears a removed schedule on an existing document; the rows are
      // stored as typed, with the derivation left to docTotals.
      schedule: hasSchedule()
        ? draft.schedule.map((r) => ({
          id: r.id || uid(),
          label: String(r.label || '').trim(),
          dueDate: r.dueDate || '',
          type: r.type === 'fixed' ? 'fixed' : 'percent',
          value: clamp(Number(r.value) || 0, 0, r.type === 'fixed' ? Infinity : 100),
        }))
        : null,
      // Null clears a removed deposit on an existing document; a value of
      // zero is no request at all, so it saves as none too.
      deposit: draft.deposit && Number(draft.deposit.value) > 0
        ? {
          type: draft.deposit.type === 'fixed' ? 'fixed' : 'percent',
          value: clamp(Number(draft.deposit.value) || 0, 0,
            draft.deposit.type === 'percent' ? 100 : Infinity),
        }
        : null,
      notes: (draft.notes || '').trim(),
    };
  }

  /* ----- Controls that client defaults can re-seed ----- */
  /**
   * Whether a date field holds a date the form can take. The browser's date
   * field accepts a year of five or six digits — one keystroke too many in
   * the year and it reads "20260-09-05" — and the app stores dates with four:
   * such a document was filed under the year "2026", printed "Sep 5, 20260",
   * and made the whole backup unrestorable, because the validator refuses a
   * file over one date shaped like that. Said once, and the field goes back
   * to what it held; an empty field is the caller's own case.
   */
  const acceptDate = (input) => {
    if (!input.value) return false;
    if (isISODate(input.value)) return true;
    toast('Enter a year between 1000 and 9999', { icon: 'alert' });
    return false;
  };
  const dateInputs = {};
  const dateInput = (prop, label) => {
    const input = el('input.input', {
      type: 'date', value: draft[prop], required: true, min: MIN_DATE, max: MAX_DATE,
      onchange: (e) => {
        // These dates are required, so a cleared field goes back to what it
        // held: saving a date the input no longer shows is worse than
        // refusing to lose it. So does a five-digit year (acceptDate).
        if (!acceptDate(e.target)) {
          e.target.value = draft[prop] || '';
          return;
        }
        draft[prop] = e.target.value;
        if (prop === 'dueDate' || prop === 'validUntil') touched[prop] = true;
        if (prop === 'issueDate') {
          applyIssueTerms();
          renderNumberPreview();
        }
        // The end-condition note counts occurrences from this date.
        if (prop === 'nextDue') renderEndNote();
      },
    });
    dateInputs[prop] = input;
    return field(label, input);
  };

  const currencySelect = el('select.select', {
    onchange: (e) => {
      draft.currency = e.target.value;
      touched.currency = true;
      currencyChanged();
    },
  }, CURRENCIES.map((c) => el('option', { value: c.code, selected: c.code === draft.currency }, c.code)));

  /**
   * Everything drawn in the document's currency, repainted together: each
   * line's amount, the installment rows (their figures, and the type picker
   * whose "fixed" option is the currency's own code), the totals, and whether
   * an exchange rate is asked for at all. The currency moves two ways — the
   * select above, and a client pick that re-seeds an untouched draft — and
   * the second used to repaint only the line amounts: picking a client billed
   * in euros on a dollar account switched every figure to € and left the
   * exchange-rate field hidden, so the rate could not be typed without first
   * touching the currency select the client had already set.
   */
  function currencyChanged() {
    renderItems();
    renderSchedule();
    renderTotals();
    renderFxField();
  }

  /* ----- Exchange rate (only when billing in someone else's money) ----- */
  // What one unit of this document's currency was worth in the account's own
  // on the day. Typed, never fetched: the app makes no outbound request on
  // the user's behalf, and a rates API would mean one per document.
  const baseCurrency = () => store.settings.baseCurrency || store.settings.currency || 'USD';
  const fxInput = el('input.input', {
    type: 'number', min: '0', step: 'any', inputmode: 'decimal',
    value: draft.fxRate ?? '', placeholder: '1.00',
    oninput: (e) => { draft.fxRate = e.target.value; renderFxNote(); },
  });
  const fxNote = el('span.field-hint.fx-note', { id: 'fx-note' });
  // A plain labelled field, not a group: the label's `for` lands on the rate
  // box, which is the only control in here, and as a group the box itself had
  // no name at all — the one control in the editor a screen reader announced
  // as a bare number field. The note under it is what the box is described by.
  fxInput.setAttribute('aria-describedby', fxNote.id);
  const fxField = field('Exchange rate', el('div.fx-row', {}, fxInput, fxNote));
  fxField.classList.add('fx-field');
  function renderFxNote() {
    const base = baseCurrency();
    const rate = Number(draft.fxRate);
    const label = fxField.querySelector('.field-label');
    if (label) label.firstChild.nodeValue = `1 ${draft.currency} = ? ${base}`;
    if (!Number.isFinite(rate) || rate <= 0) {
      fxNote.textContent = 'Optional. Without one, this document is left out of the consolidated totals in Reports.';
      return;
    }
    const t = docTotals(draft);
    fxNote.textContent = `${fmtMoney(t.total, draft.currency)} = ${fmtMoney(inBase(t.total, rate), base)}`;
  }
  function renderFxField() {
    // Nothing to convert when the document is already in the account's own
    // money, so the field stays out of the way entirely.
    fxField.hidden = isRule || draft.currency === baseCurrency();
    renderFxNote();
  }

  /* ----- Taxes: one row per named rate ----- */
  const taxesWrap = el('div.tax-rows');
  function renderTaxRows() {
    clear(taxesWrap);
    draft.taxes.forEach((tx, i) => {
      taxesWrap.append(el('div.tax-row', {},
        el('input.input', {
          value: tx.label, placeholder: 'VAT, GST…',
          'aria-label': `Tax ${i + 1} name`,
          // Naming a tax is editing the taxes: without the touched mark, the
          // next client pick would re-seed the list and discard the typed
          // name. The line rows re-render too — each line's tax picker offers
          // the document's taxes by value, and a picker left offering the old
          // name or rate would store a treatment the document no longer has.
          oninput: (e) => { tx.label = e.target.value; touched.taxes = true; renderItems(); renderTotals(); },
        }),
        el('input.input', {
          type: 'number', min: '0', max: '100', step: 'any', value: tx.rate,
          placeholder: '0', inputmode: 'decimal',
          'aria-label': `Tax ${i + 1} rate (%)`,
          oninput: (e) => { tx.rate = e.target.value; touched.taxes = true; renderItems(); renderTotals(); },
          // A number input accepts typed values outside its min/max, so pin
          // the rate to 0–100 when the field is left — the paper prints it
          // in the row's own label right beside the amount.
          onchange: (e) => {
            if (e.target.value === '') return;
            const pinned = clamp(Number(e.target.value) || 0, 0, 100);
            e.target.value = pinned;
            tx.rate = pinned;
            renderItems();
            renderTotals();
          },
        }),
        el('button.icon-btn.item-remove', {
          type: 'button', html: icon('x', 17, 1.6),
          'aria-label': `Remove tax ${i + 1}`,
          onclick: () => {
            draft.taxes.splice(i, 1);
            touched.taxes = true;
            renderTaxRows();
            renderItems();
            renderTotals();
            // The re-render destroyed the pressed button: keep focus among
            // the remaining rows, or on Add tax once none are left.
            const removes = taxesWrap.querySelectorAll('.item-remove');
            (removes[Math.min(i, removes.length - 1)] || taxesWrap.querySelector('.add-line'))?.focus();
          },
        })));
    });
    taxesWrap.append(el('button.btn.btn-ghost.add-line', {
      type: 'button', html: icon('plus', 15, 1.8),
      onclick: () => {
        draft.taxes.push({ label: '', rate: '' });
        touched.taxes = true;
        renderTaxRows();
        renderItems();
        taxesWrap.querySelector('.tax-row:last-of-type input')?.focus();
      },
    }, ' Add tax'));
  }

  /* ----- Tax note (why no tax is charged) ----- */
  // A document only inherits: '' follows the client, then Settings, so most
  // documents never need this touched. The preview says what will actually
  // print, because "inherit" is invisible otherwise — and because the note
  // only appears when the document charges no tax on something.
  const taxNote = taxNoteControl(draft.taxNote, { inheritLabel: 'Client’s default' });
  const taxNotePreview = el('p.card-sub.tax-note-preview', { 'aria-live': 'polite' });
  function renderTaxNotePreview() {
    const read = taxNote.read();
    if (read.error) {
      // Mid-edit, not a refusal yet: say what the box is waiting for rather
      // than previewing the sentence it is about to replace.
      taxNotePreview.textContent = 'Type the wording to print, or pick one above.';
      return;
    }
    const client = store.client(draft.clientId);
    const tr = translator(docLang({ language: draft.language }, client));
    const stored = read.value;
    const text = taxNoteText(taxNoteValue(store.settings, { taxNote: stored }, client), tr);
    const untaxed = chargesUntaxed({ ...draft, items: draft.items });
    taxNotePreview.textContent = !text
      ? 'Nothing is printed about tax.'
      : untaxed
        ? `Prints: “${text}”`
        : `Would print “${text}”, but this document charges tax on every line, so it stays off.`;
  }
  taxNote.onChange(renderTaxNotePreview);

  const notesInput = el('textarea.textarea', {
    rows: 3, value: draft.notes || '',
    placeholder: 'Payment details, thank-you note, terms…',
    oninput: (e) => { draft.notes = e.target.value; touched.notes = true; },
  });

  // Whether the prices above already carry the tax. Per document, because a
  // business quoting consumers inclusive may still bill another business
  // exclusive; the default lives in Settings.
  const taxInclusiveRow = el('label.check-row', {},
    el('input', {
      type: 'checkbox', checked: !!draft.taxInclusive,
      onchange: (e) => { draft.taxInclusive = e.target.checked; renderTotals(); },
    }),
    el('span', {}, 'Prices include tax'));

  /**
   * Re-seed the untouched parts of a new draft from the chosen client, so
   * picking Acme switches the currency, terms, tax, and notes without
   * disturbing anything already typed. Existing documents are never re-seeded.
   */
  function applyClientDefaults() {
    // The tax-note preview reads the client's own wording; repainted for
    // an existing document too, which returns below before the totals
    // repaint that used to be the only other thing refreshing it — so a
    // client switch left it promising a sentence the paper would not print.
    renderTaxNotePreview();
    if (!isNew) return;
    const d = billingDefaults(s, store.client(draft.clientId));
    if (!touched.currency && draft.currency !== d.currency) {
      draft.currency = d.currency;
      currencySelect.value = d.currency;
      currencyChanged();
    }
    if (!touched.taxes) {
      draft.taxes = defaultTaxes(s, store.client(draft.clientId)).map((t) => ({ ...t }));
      renderTaxRows();
      renderItems();
    }
    if (!touched.notes) {
      draft.notes = d.notes;
      notesInput.value = d.notes;
    }
    if (!touched.dueDate && isInvoice && !isRule && dateInputs.dueDate) {
      draft.dueDate = addDays(draft.issueDate, d.paymentTermsDays);
      dateInputs.dueDate.value = draft.dueDate;
    }
    renderTotals();
  }

  /**
   * A new document's deadline follows its issue date until someone sets it by
   * hand. Terms are counted from the issue date, so backdating an invoice a
   * fortnight has to move its due date along with it; leaving a due date
   * measured from today would quietly extend the terms — or, when the issue
   * date moves forward, hand the client an invoice that is already overdue.
   */
  function applyIssueTerms() {
    if (!isNew || isRule || !draft.issueDate) return;
    if (isInvoice) {
      if (touched.dueDate || !dateInputs.dueDate) return;
      const { paymentTermsDays } = billingDefaults(s, store.client(draft.clientId));
      draft.dueDate = addDays(draft.issueDate, paymentTermsDays);
      dateInputs.dueDate.value = draft.dueDate;
    } else {
      if (touched.validUntil || !dateInputs.validUntil) return;
      draft.validUntil = addDays(draft.issueDate, termDays(s.quoteValidDays, 30));
      dateInputs.validUntil.value = draft.validUntil;
    }
  }

  /* ----- End condition (schedules only) ----- */
  // Plenty of engagements are fixed-term: a six-month retainer, a twelve
  // instalment plan. Without a boundary the automation becomes a liability.
  const alreadyIssued = mode === 'edit-rule'
    ? Math.max(issuedCount(source), store.docs().filter((d) => d.recurringId === source.id).length)
    : 0;

  const endDateInput = el('input.input', {
    type: 'date', value: draft.endDate || '', min: MIN_DATE, max: MAX_DATE,
    onchange: (e) => {
      // A cleared field goes back to what it held, like the editor's other
      // dates: saving "ends on a date" with no date would read as complete
      // in the note here while the rule actually drafts forever.
      if (!acceptDate(e.target)) {
        e.target.value = draft.endDate || '';
        return;
      }
      draft.endDate = e.target.value;
      renderEndNote();
    },
  });
  const endCountInput = el('input.input', {
    type: 'number', min: '1', step: '1', inputmode: 'numeric',
    value: draft.endCount || '', placeholder: '6',
    oninput: (e) => { draft.endCount = e.target.value; renderEndNote(); },
    // Save stores max(1, round(n)); pin the field on blur so a typed 0 or
    // -3 doesn't sit on screen while 1 is what the schedule will honour.
    onchange: (e) => {
      if (e.target.value === '') return;
      const pinned = Math.max(1, Math.round(Number(e.target.value) || 1));
      e.target.value = pinned;
      draft.endCount = pinned;
      renderEndNote();
    },
  });
  const endDateField = field('Last invoice on or before', endDateInput);
  const endCountField = field('Number of invoices', endCountInput, {
    hint: alreadyIssued ? `${alreadyIssued} drafted so far` : 'in total',
  });
  const endNote = el('p.card-sub.end-note');
  const endModeSelect = el('select.select', {
    onchange: (e) => { draft.endMode = e.target.value; syncEnd(); },
  },
    el('option', { value: 'never', selected: (draft.endMode || 'never') === 'never' }, 'Never'),
    el('option', { value: 'date', selected: draft.endMode === 'date' }, 'On a date'),
    el('option', { value: 'count', selected: draft.endMode === 'count' }, 'After a number of invoices'));

  function syncEnd() {
    endDateField.hidden = draft.endMode !== 'date';
    endCountField.hidden = draft.endMode !== 'count';
    // Give a just-chosen condition a sensible value rather than an empty one.
    if (draft.endMode === 'date' && !draft.endDate) {
      draft.endDate = addMonthsClamped(draft.nextDue || today, 6);
      endDateInput.value = draft.endDate;
    }
    if (draft.endMode === 'count' && !draft.endCount) {
      draft.endCount = alreadyIssued + 6;
      endCountInput.value = draft.endCount;
    }
    renderEndNote();
  }

  /**
   * The anchor day the rule will save with. It only moves when the user
   * picks a new date: an existing rule's nextDue may sit clamped in a short
   * month (a rule anchored to the 31st reads Feb 28 there), and re-deriving
   * the anchor from it on an unrelated edit would drift the schedule to the
   * 28th for good — the exact drift anchorDay exists to prevent.
   */
  const ruleAnchorDay = () => (mode === 'new-rule' || draft.nextDue !== source?.nextDue || !source?.anchorDay
    ? Number(draft.nextDue?.slice(8, 10)) || 1
    : source.anchorDay);

  function renderEndNote() {
    // The preview counts with exactly what Save would store — including the
    // re-derived anchor day, so the occurrence count near a month-end date
    // matches the schedule that will actually run.
    const preview = {
      ...draft,
      anchorDay: ruleAnchorDay(),
      issued: alreadyIssued,
      endCount: Math.max(1, Math.round(Number(draft.endCount) || 1)),
    };
    const left = remainingOccurrences(preview);
    if (draft.endMode === 'count') {
      endNote.textContent = left
        ? `${alreadyIssued} of ${preview.endCount} drafted so far · ${left} to go.`
        : `That is ${alreadyIssued} already drafted, so this schedule is complete and drafts nothing further.`;
    } else if (draft.endMode === 'date') {
      endNote.textContent = left
        ? `${left} more invoice${left === 1 ? '' : 's'} up to ${fmtDate(draft.endDate)}.`
        : `Nothing falls on or before ${fmtDate(draft.endDate)}, so this schedule is complete.`;
    } else {
      endNote.textContent = 'Runs until you pause or delete it.';
    }
  }
  if (isRule) syncEnd();

  /* ----- Layout ----- */
  const detailsCard = el('section.card.editor-card', {},
    el('h2.card-title', {}, 'Details'),
    isRule && field('Name', el('input.input', {
      value: draft.name || '', placeholder: 'e.g. Monthly retainer',
      oninput: (e) => { draft.name = e.target.value; },
    }), { hint: '(optional)' }),
    field('Client', el('div.client-row', {},
      selectWrap(clientSelect),
      el('button.btn.btn-ghost.client-add', {
        type: 'button', html: icon('plus', 15, 1.8),
        onclick: () => openClientForm(null, (c) => {
          draft.clientId = c.id;
          renderClientOptions();
          applyClientDefaults();
        }),
      }, ' New'))),
    el('div.field-grid', {},
      ...(isRule
        ? [
          field('Repeats', selectWrap(el('select.select', {
            // The end-condition note counts occurrences at this cadence.
            onchange: (e) => { draft.freq = e.target.value; renderEndNote(); },
          }, FREQUENCIES.map((f) => el('option', { value: f.value, selected: f.value === draft.freq }, f.label))))),
          dateInput('nextDue', 'Next invoice on'),
          field('Ends', selectWrap(endModeSelect)),
          endDateField,
          endCountField,
        ]
        : [
          dateInput('issueDate', 'Issue date'),
          isInvoice ? dateInput('dueDate', 'Due date') : dateInput('validUntil', 'Valid until'),
        ]),
      field('Currency', selectWrap(currencySelect)),
      // The client's own purchase-order or reference number, printed in the
      // paper's meta block where their accounts-payable department looks
      // for it. Schedules don't carry one: a PO belongs to a document.
      !isRule && field('PO / reference', el('input.input', {
        value: draft.reference || '', placeholder: 'e.g. PO-2026-118',
        oninput: (e) => { draft.reference = e.target.value; },
      }), { hint: '(optional)' }),
      // What language this one document's paper renders in. '' follows the
      // client, so most documents never need the field touched. Schedules
      // inherit at render time through the client the same way.
      !isRule && field('Language', selectWrap(el('select.select', {
        // The preview speaks the paper's language, so it follows this.
        onchange: (e) => { draft.language = e.target.value; renderTaxNotePreview(); },
      },
        el('option', { value: '', selected: !draft.language }, "Client's language"),
        LANGS.map((l) => el('option', {
          value: l.code, selected: draft.language === l.code,
        }, l.label)))), { hint: 'of the paper' }),
      // Last, on a row of its own (see .fx-field): it appears only when the
      // currency is not the account's, and it carries a sentence under its
      // box. In a cell beside the dates it made its row a sentence tall, and
      // the grid — which pins every field's contents to the row's bottom so
      // that wrapped labels never stagger the inputs — dropped the date,
      // currency, and reference boxes ninety pixels below the rate box, with
      // a blank band over their labels.
      fxField
    ),
    isRule ? endNote : null
  );

  const itemsCard = el('section.card.editor-card', {},
    el('h2.card-title', {}, 'Line items'),
    // Qty and Rate head their own left-aligned inputs; Amount heads a
    // right-aligned figure and has to sit over it.
    el('div.item-head', { 'aria-hidden': 'true' },
      el('span', {}, 'Description'), el('span', {}, 'Qty / unit'),
      el('span', {}, 'Rate'), el('span.num', {}, 'Amount'), el('span')),
    itemsWrap,
    datalist,
    unitList,
    el('div.side-actions', {},
      el('button.btn.btn-ghost.add-line', {
        type: 'button', html: icon('plus', 15, 1.8),
        onclick: () => {
          draft.items.push({ id: uid(), name: '', qty: 1, rate: '', unit: '' });
          renderItems();
          itemsWrap.querySelector('.item-row:last-of-type input')?.focus();
        },
      }, ' Add line'),
      el('button.btn.btn-ghost.add-line', {
        type: 'button', html: icon('upload', 15, 1.6),
        onclick: () => openLineImport(addImportedLines),
      }, ' Fill from a spreadsheet'))
  );

  /**
   * Lines arriving from a CSV join the form exactly as typed ones would:
   * a name that matches the price list fills its blank rate, unit, and tax
   * treatment — a spreadsheet of timekeepers and hours never has to repeat
   * the rates the account already knows — and rows that say nothing (the
   * seeded blank, an emptied leftover) give way rather than sit between.
   */
  function addImportedLines(lines) {
    const suggestions = store.itemSuggestions();
    const filled = lines.map((line) => {
      const next = { id: uid(), qty: 1, rate: '', ...line, name: String(line.name ?? '') };
      const match = suggestions.find((sug) => sug.name === next.name)
        || suggestions.find((sug) => String(sug.name || '').toLowerCase() === next.name.toLowerCase());
      if (!match) return next;
      // Only a blank rate is the price list's to fill: a written 0 is the
      // file's own word (a courtesy line), and prepareLineItems keeps the two
      // apart for exactly this.
      if (next.rate === '') next.rate = match.rate;
      if (match.unit && !String(next.unit || '').trim()) next.unit = match.unit;
      if (Array.isArray(match.taxes) && !Array.isArray(next.taxes)) {
        next.taxes = match.taxes.map((t) => ({ ...t }));
      }
      return next;
    });
    draft.items = [
      ...draft.items.filter(saysSomething),
      ...filled,
    ];
    renderItems();
    renderTotals();
  }

  const extrasCard = el('section.card.editor-card', {},
    el('h2.card-title', {}, 'Adjustments & notes'),
    el('div.field-grid', {},
      field('Discount', el('div.duo', {}, selectWrap(discountSelect), discountValueInput)),
      // A schedule never asks for money up front: each generated invoice
      // bills a period already agreed to.
      depositField),
    field('Taxes', taxesWrap, { hint: 'each prints as its own row; a line can pick its own treatment', group: true }),
    el('div.field', {}, taxInclusiveRow),
    // Estimates quote a price; the plan for paying it belongs to the invoice,
    // where the dates are real. A recurring rule bills one period at a time.
    isInvoice && !isRule && field('Payment schedule', scheduleWrap, {
      hint: 'split the total over dates', group: true,
    }),
    isInvoice && !isRule && scheduleNote,
    // Schedules render through the invoices they draft, which carry the
    // client's and the account's wording; a rule of its own would only be a
    // fourth place for the same sentence to disagree from.
    !isRule && field('Tax note', taxNote.node, {
      hint: 'when no tax is charged', group: true,
    }),
    !isRule && taxNotePreview,
    field('Notes', notesInput, { hint: '(shown on the document)' }),
    totalsWrap
  );

  // One pair of actions, in the bar pinned to the bottom of the form. The
  // header used to carry a second copy of Cancel and Create for the sake of
  // long documents; now that the bar follows the viewport, two identical
  // pairs on screen at once is all that copy would be. The bar spans the
  // panel; the pair inside it keeps to the form's own column.
  root.append(
    el('div.page-head', {},
      el('div', {},
        el('div.back-row', {},
          el('a.back-link', { href: backHash, html: icon('back', 16, 1.8) }, ' Back')),
        el('h1.page-title', {}, title),
        numberPreview,
        // Say where the pre-filled form came from — and that backing out is
        // free, which is the whole difference from Duplicate.
        copyFrom && el('p.page-sub', {},
          `Copied from ${copyFrom.number}. Nothing is saved until you press Create.`))),
    el('div.editor-grid', {}, detailsCard, itemsCard, extrasCard),
    el('div.editor-footer', {},
      el('div.editor-footer-inner', {},
        el('button.btn.btn-ghost', { type: 'button', onclick: () => navigate(backHash) }, 'Cancel'),
        el('button.btn.btn-primary', {
          type: 'button', onclick: () => save(),
        }, mode.startsWith('new') ? 'Create' : 'Save changes')))
  );

  renderTaxRows();
  renderItems();
  renderSchedule();
  renderFxField();
  renderTotals();
  return root;
}
