import { describe, it, expect } from 'vitest';
import { paperHTML, statementHTML } from '../src/ui/paper.js';
import { fmtMoney } from '../src/lib/money.js';
import { docSpec, pdfMoney } from '../src/lib/pdf-spec.js';

const settings = { business: { name: 'Aurora Studio' }, taxLabel: 'Tax' };

const invoice = (over = {}) => ({
  kind: 'invoice',
  number: 'INV-0042',
  clientId: 'c1',
  currency: 'USD',
  issueDate: '2026-07-20',
  dueDate: '2026-08-20',
  items: [{ id: 'l1', name: 'Brand design (day)', qty: 4, rate: 800 }],
  taxRate: 0,
  discountType: 'none',
  discountValue: 0,
  notes: '',
  status: 'sent',
  payments: [],
  ...over,
});

/* The client block, as the paper the client actually sees renders it.
   Must agree with pdf-spec's clientBlock: same name fallback, no repeats. */
describe('Algerian business identifiers in HTML papers', () => {
  it('prints optional NIF, NIS and RC fields in the business header', () => {
    const html = paperHTML(invoice(), null, {
      business: { name: 'Entreprise Exemple', nif: '123456789012345', nis: '123456789012345', rc: 'RC-EXAMPLE-001' },
    }, {});
    expect(html).toContain('NIF: 123456789012345');
    expect(html).toContain('NIS: 123456789012345');
    expect(html).toContain('RC: RC-EXAMPLE-001');
  });
});

describe('paperHTML client block', () => {
  it('shows name and company when they differ', () => {
    const html = paperHTML(invoice(), { id: 'c1', name: 'Maya Chen', company: 'Northwind Labs' }, settings, {});
    expect(html).toContain('<div class="paper-client-name">Maya Chen</div>');
    expect(html).toContain('Northwind Labs');
  });

  it('names a company-only client by their company, once', () => {
    const html = paperHTML(invoice(), { id: 'c1', name: '', company: 'Northwind Labs' }, settings, {});
    expect(html).toContain('<div class="paper-client-name">Northwind Labs</div>');
    expect(html.match(/Northwind Labs/g)).toHaveLength(1);
  });

  it('does not repeat a company that matches the client name', () => {
    const both = { id: 'c1', name: 'Northwind Labs', company: 'Northwind Labs', email: 'maya@northwind.example' };
    const html = paperHTML(invoice(), both, settings, {});
    expect(html.match(/Northwind Labs/g)).toHaveLength(1);
    expect(html).toContain('maya@northwind.example');
  });

  it('escapes what it prints', () => {
    const html = paperHTML(invoice(), { id: 'c1', name: '', company: '<img src=x onerror=alert(1)>' }, settings, {});
    expect(html).not.toContain('<img');
  });

  it('prints the client tax ID under the bill-to block', () => {
    const withId = { id: 'c1', name: 'Maya Chen', company: 'Northwind Labs', taxId: 'DE 123456789' };
    expect(paperHTML(invoice(), withId, settings, {})).toContain('Tax ID: DE 123456789');
    // A client without one renders exactly as before.
    expect(paperHTML(invoice(), { id: 'c1', name: 'Maya Chen' }, settings, {})).not.toContain('Tax ID:');
  });

  it('escapes the client tax ID', () => {
    const html = paperHTML(invoice(), { id: 'c1', name: 'Maya', taxId: '<b>x</b>' }, settings, {});
    expect(html).not.toContain('<b>x</b>');
    expect(html).toContain('&lt;b&gt;x&lt;/b&gt;');
  });
});

/* The stamp on a paper rendered without a date — the share page's call
   shape. What the document says about itself prints; what only the clock
   could say does not. */
describe('paperHTML stamp without a date', () => {
  it('stamps a void or paid invoice, and never an overdue one', () => {
    expect(paperHTML(invoice({ status: 'void' }), null, settings, {})).toContain('paper-stamp tone-neutral">Void<');
    expect(paperHTML(invoice({ payments: [{ amount: 3200 }] }), null, settings, {})).toContain('paper-stamp tone-ok">Paid<');
    expect(paperHTML(invoice({ dueDate: '2020-01-01' }), null, settings, {})).not.toContain('paper-stamp');
    expect(paperHTML(invoice({ dueDate: '2020-01-01' }), null, settings, { today: '2026-08-04' })).toContain('>Overdue<');
  });

  it('stamps a declined estimate, and never an expired one', () => {
    const quote = invoice({ kind: 'quote', validUntil: '2020-01-01' });
    expect(paperHTML({ ...quote, status: 'declined' }, null, settings, {})).toContain('>Declined<');
    expect(paperHTML(quote, null, settings, {})).not.toContain('paper-stamp');
  });
});

describe('Algerian business identifiers in PDF specs', () => {
  it('includes NIF, NIS and RC in the business block when provided', () => {
    const spec = docSpec(invoice(), null, {
      business: { name: 'Entreprise Exemple', nif: '123456789012345', nis: '123456789012345', rc: 'RC-EXAMPLE-001' },
      taxLabel: 'TVA',
    });
    expect(spec.biz.lines).toContain('NIF: 123456789012345');
    expect(spec.biz.lines).toContain('NIS: 123456789012345');
    expect(spec.biz.lines).toContain('RC: RC-EXAMPLE-001');
  });
});

describe('paperHTML document language', () => {
  it("renders the fixed labels in the client's language", () => {
    const html = paperHTML(invoice(), { id: 'c1', name: 'Jonas Weber', language: 'de' }, settings, {});
    expect(html).toContain('RECHNUNG'.charAt(0) + 'echnung'); // 'Rechnung'
    expect(html).toContain('Zwischensumme');
    expect(html).toContain('Gesamtbetrag');
    expect(html).toContain('Rechnung an');
  });

  it('lets a document override its client', () => {
    const html = paperHTML(invoice({ language: 'fr' }), { id: 'c1', name: 'Jonas', language: 'de' }, settings, {});
    expect(html).toContain('Facture');
    expect(html).not.toContain('Rechnung');
  });

  it('stays exactly English when nothing sets a language', () => {
    const html = paperHTML(invoice(), { id: 'c1', name: 'Maya Chen' }, settings, {});
    expect(html).toContain('Invoice');
    expect(html).toContain('Subtotal');
    expect(html).toContain('Billed to');
  });
});

describe('paperHTML named taxes', () => {
  it('prints one row per named tax', () => {
    const html = paperHTML(invoice({
      taxes: [{ label: 'GST', rate: 5 }, { label: 'PST', rate: 7 }],
    }), null, settings, {});
    expect(html).toContain('GST (5%)');
    expect(html).toContain('PST (7%)');
  });

  it('renders a legacy single rate with the settings label, exactly as before', () => {
    const html = paperHTML(invoice({ taxRate: 8.5 }), null, { ...settings, taxLabel: 'VAT' }, {});
    expect(html).toContain('VAT (8.5%)');
  });

  it('escapes tax labels', () => {
    const html = paperHTML(invoice({ taxes: [{ label: '<b>x</b>', rate: 5 }] }), null, settings, {});
    expect(html).not.toContain('<b>x</b>');
  });
});

describe('paperHTML tax-inclusive pricing', () => {
  it('prints the tax portion as a disclosure under the total', () => {
    const html = paperHTML(invoice({ taxRate: 20, taxInclusive: true }), null, settings, {});
    expect(html).toContain('Includes Tax (20%)');
    expect(html).not.toMatch(/<span>Tax \(20%\)<\/span>/);
    // The total is the quoted price, not price-plus-tax.
    expect(html).toContain('$3,200.00');
    expect(html).not.toContain('$3,840.00');
  });

  it('keeps the added-on row for exclusive documents', () => {
    const html = paperHTML(invoice({ taxRate: 20 }), null, settings, {});
    expect(html).toMatch(/<span>Tax \(20%\)<\/span>/);
    expect(html).not.toContain('Includes Tax');
  });
});

describe('paperHTML deposit', () => {
  it('asks for the deposit beside the total while nothing is paid', () => {
    const html = paperHTML(invoice({ deposit: { type: 'percent', value: 25 } }), null, settings, {});
    expect(html).toContain('Deposit due (25%)');
    expect(html).toContain('$800.00');
  });

  it('drops the deposit row from the first payment on', () => {
    const html = paperHTML(invoice({
      deposit: { type: 'percent', value: 25 },
      payments: [{ amount: 800 }],
    }), null, settings, {});
    expect(html).not.toContain('Deposit due');
    expect(html).toContain('Balance due');
  });

  it('shows a deposit asked on an estimate too', () => {
    const quote = invoice({ kind: 'quote', validUntil: '2026-09-01', deposit: { type: 'fixed', value: 500 } });
    expect(paperHTML(quote, null, settings, {})).toContain('Deposit due');
  });
});

describe('paperHTML payment instructions', () => {
  const withBank = { ...settings, paymentInstructions: 'IBAN DE00 1234' };

  it('prints them under their own heading while a balance is due', () => {
    const html = paperHTML(invoice(), null, withBank, {});
    expect(html).toContain('Payment details');
    expect(html).toContain('IBAN DE00 1234');
  });

  it('lets a client override them, escaped', () => {
    const html = paperHTML(invoice(), { id: 'c1', name: 'Maya', paymentInstructions: 'Portal <x>' }, withBank, {});
    expect(html).toContain('Portal &lt;x&gt;');
    expect(html).not.toContain('IBAN DE00 1234');
  });

  it('drops them once the invoice is settled and never puts them on estimates', () => {
    expect(paperHTML(invoice({ payments: [{ amount: 3200 }] }), null, withBank, {}))
      .not.toContain('Payment details');
    expect(paperHTML(invoice({ kind: 'quote', validUntil: '2026-09-01' }), null, withBank, {}))
      .not.toContain('Payment details');
  });
});

describe('paperHTML late-fee disclosure', () => {
  const withPolicy = { ...settings, lateFee: { type: 'percent', value: 2 } };

  it('discloses the policy while the invoice asks for money', () => {
    const html = paperHTML(invoice(), null, withPolicy, {});
    expect(html).toContain('Late fee');
    expect(html).toContain('A late fee of 2% per month applies after the due date.');
  });

  it("prefers the client's own policy, and says nothing once settled", () => {
    const html = paperHTML(invoice(), { id: 'c1', name: 'Maya', lateFee: { type: 'none', value: 0 } }, withPolicy, {});
    expect(html).not.toContain('Late fee');
    expect(paperHTML(invoice({ payments: [{ amount: 3200 }] }), null, withPolicy, {}))
      .not.toContain('Late fee');
    expect(paperHTML(invoice({ kind: 'quote', validUntil: '2026-09-01' }), null, withPolicy, {}))
      .not.toContain('Late fee');
  });
});

describe('paperHTML reference', () => {
  it('prints the PO / reference in the meta block, escaped', () => {
    const html = paperHTML(invoice({ reference: 'PO <2026>' }), null, settings, {});
    expect(html).toContain('Reference');
    expect(html).toContain('PO &lt;2026&gt;');
  });

  it('leaves the row out when there is no reference', () => {
    expect(paperHTML(invoice(), null, settings, {})).not.toContain('Reference');
  });
});

describe('paperHTML dates', () => {
  it('says "on receipt" for a due-less invoice', () => {
    const html = paperHTML(invoice({ dueDate: '' }), null, settings, {});
    expect(html).toContain('On receipt');
  });

  it('omits the expiry row of an estimate without a valid-until', () => {
    // Reachable through restored or legacy data; the editor requires the date.
    const html = paperHTML(invoice({ kind: 'quote', dueDate: undefined, validUntil: '' }), null, settings, {});
    expect(html).not.toContain('Valid until');
    expect(html).not.toContain('On receipt');
    expect(html).toContain('Issued');
  });
});

describe('paperHTML units', () => {
  it('prints the unit beside the quantity', () => {
    const html = paperHTML(invoice({
      items: [{ id: 'l1', name: 'Studio time', qty: 12, rate: 85, unit: 'hours' }],
    }), null, settings, {});
    expect(html).toContain('<td class="num">12 hours</td>');
  });

  it('leaves a line without a unit exactly as it was', () => {
    const html = paperHTML(invoice(), null, settings, {});
    expect(html).toContain('<td class="num">4</td>');
  });

  it('escapes a unit the user typed', () => {
    const html = paperHTML(invoice({
      items: [{ id: 'l1', name: 'Thing', qty: 2, rate: 5, unit: '<b>x</b>' }],
    }), null, settings, {});
    expect(html).not.toContain('<b>x</b>');
    expect(html).toContain('2 &lt;b&gt;x&lt;/b&gt;');
  });
});

describe('paperHTML work descriptions', () => {
  it('prints a line’s details under its name, line breaks kept', () => {
    const html = paperHTML(invoice({
      items: [{
        id: 'l1', name: 'J. Smith', qty: 3.5, rate: 300, unit: 'hours',
        details: 'Drafted the motion\nReviewed exhibits',
      }],
    }), null, settings, {});
    expect(html).toContain('<div class="paper-item-details">Drafted the motion<br>Reviewed exhibits</div>');
  });

  it('renders a line without details exactly as before', () => {
    const html = paperHTML(invoice(), null, settings, {});
    expect(html).not.toContain('paper-item-details');
  });

  it('escapes the details like everything else the user typed', () => {
    const html = paperHTML(invoice({
      items: [{ id: 'l1', name: 'Work', qty: 1, rate: 5, details: '<img src=x onerror=alert(1)>' }],
    }), null, settings, {});
    expect(html).not.toContain('<img');
  });
});

describe('the statement’s aging summary', () => {
  const open = (over = {}) => invoice({
    id: 'x', number: 'INV-0100', issueDate: '2026-05-01', dueDate: '2026-08-01', ...over,
  });

  it('breaks the balance down by age under the totals', () => {
    const html = statementHTML({ id: 'c1', name: 'Maya Chen' }, [
      open({ number: 'INV-0100', dueDate: '2026-07-20' }),
      open({ number: 'INV-0101', dueDate: '2026-01-01' }),
    ], settings, { today: '2026-08-04' });
    expect(html).toContain('Outstanding by age');
    expect(html).toContain('1–30 days');
    expect(html).toContain('Over 90 days');
  });

  it('stays away when every invoice is the same age', () => {
    const html = statementHTML({ id: 'c1', name: 'Maya Chen' }, [open()], settings, { today: '2026-08-04' });
    expect(html).not.toContain('Outstanding by age');
  });

  it('says nothing on a statement with no date to age against', () => {
    const html = statementHTML({ id: 'c1', name: 'Maya Chen' }, [
      open({ dueDate: '2026-07-20' }), open({ number: 'INV-0101', dueDate: '2026-01-01' }),
    ], settings, {});
    expect(html).not.toContain('Outstanding by age');
  });
});

describe('the tax note on the paper', () => {
  const exempt = (over = {}) => invoice({ taxes: [], ...over });

  it('prints the inherited sentence when no tax is charged', () => {
    const html = paperHTML(exempt(), { id: 'c1', name: 'Maya' },
      { ...settings, taxNote: 'preset:reverseCharge' }, {});
    expect(html).toContain('Reverse charge');
    expect(html).toContain('paper-label">Tax<');
  });

  it('stays off a document that charges tax on every line', () => {
    const html = paperHTML(invoice({ taxes: [{ label: 'VAT', rate: 20 }] }), null,
      { ...settings, taxNote: 'preset:reverseCharge' }, {});
    expect(html).not.toContain('Reverse charge');
  });

  it('renders in the document’s language', () => {
    const html = paperHTML(exempt({ language: 'de' }), null,
      { ...settings, taxNote: 'preset:reverseCharge' }, {});
    expect(html).toContain('Steuerschuldnerschaft');
  });

  it('lets a client’s own wording win, and escapes it', () => {
    const html = paperHTML(exempt(), { id: 'c1', name: 'Maya', taxNote: '<b>Article 44</b>' },
      { ...settings, taxNote: 'preset:reverseCharge' }, {});
    expect(html).not.toContain('<b>Article 44</b>');
    expect(html).toContain('&lt;b&gt;Article 44&lt;/b&gt;');
    expect(html).not.toContain('Reverse charge');
  });

  it('changes nothing on an account that has never set one', () => {
    expect(paperHTML(exempt(), null, settings, {})).not.toContain('paper-label">Tax<');
  });
});

describe('the payment schedule on the paper', () => {
  const plan = (over = {}) => invoice({
    items: [{ id: 'l1', name: 'Project', qty: 1, rate: 3000 }],
    schedule: [
      { id: 'a', label: 'On signing', dueDate: '2026-07-01', type: 'percent', value: 50 },
      { id: 'b', label: 'On delivery', dueDate: '2026-09-01', type: 'percent', value: 50 },
    ],
    ...over,
  });

  it('prints each part with its date, label, and amount', () => {
    const html = paperHTML(plan(), null, settings, {});
    expect(html).toContain('Payment schedule');
    expect(html).toContain('On signing');
    expect(html).toContain('On delivery');
    expect(html.match(/\$1,500\.00/g).length).toBeGreaterThanOrEqual(2);
  });

  it('says what has been covered and what is still open', () => {
    const html = paperHTML(plan({ payments: [{ id: 'p', amount: 2000 }] }), null, settings, {});
    expect(html).toContain('On signing · <span class="paper-inst-state">Paid</span>');
    expect(html).toContain('$1,000.00 open');
  });

  it('escapes a label the user typed', () => {
    const html = paperHTML(plan({
      schedule: [{ id: 'a', label: '<b>x</b>', dueDate: '2026-07-01', type: 'percent', value: 100 }],
    }), null, settings, {});
    expect(html).not.toContain('<b>x</b>');
  });

  it('leaves a document without a schedule exactly as it was', () => {
    expect(paperHTML(invoice(), null, settings, {})).not.toContain('Payment schedule');
  });

  it('dates the header by the earliest open installment, as the stamp does', () => {
    // The invoice's own date is a month before the first part asks for
    // anything; the header used to print it beside a plan that contradicted it.
    const flat = (html) => html.replace(/>\s+</g, '><');
    const due = (html) => flat(html).match(/<div class="paper-label">Due<\/div><div>([^<]*)<\/div>/)?.[1];
    expect(due(paperHTML(plan({ dueDate: '2026-06-01' }), null, settings, {}))).toBe('Jul 1, 2026');
    // Once the first part is settled the next one is the date that matters.
    expect(due(paperHTML(plan({ dueDate: '2026-06-01', payments: [{ id: 'p', amount: 1500 }] }), null, settings, {})))
      .toBe('Sep 1, 2026');
    // Without a schedule the invoice's own date is the only one there is.
    expect(due(paperHTML(invoice(), null, settings, {}))).toBe('Aug 20, 2026');
  });

  it('dates a statement row by the earliest open installment', () => {
    const html = statementHTML({ id: 'c1', name: 'Maya' }, [plan()], settings, { today: '2026-08-04' });
    // Due Jul 1 (the open part), flagged overdue, not the December-ish final date.
    expect(html).toContain('Jul 1, 2026');
    expect(html).toContain('overdue');
  });

  it('heads the account notes on a statement the way the PDF statement does', () => {
    const html = statementHTML({ id: 'c1', name: 'Maya' }, [plan()],
      { ...settings, defaultNotes: 'Payable within 14 days.' }, { today: '2026-08-04' });
    expect(html.replace(/>\s+</g, '><')).toContain('<div class="paper-label">Notes</div><div class="paper-sub">Payable within 14 days.</div>');
    expect(statementHTML({ id: 'c1', name: 'Maya' }, [plan()], settings, { today: '2026-08-04' }))
      .not.toContain('paper-label">Notes<');
  });

  it('counts only the late half of a plan as overdue on a statement', () => {
    const html = statementHTML({ id: 'c1', name: 'Maya' }, [plan()], settings, { today: '2026-08-04' });
    // $3,000 due in all; the September half is not overdue because the July half is.
    const flat = html.replace(/>\s+</g, '><');
    expect(flat).toContain(`<span>Total due</span><span class="num">${fmtMoney(3000, 'USD')}</span>`);
    expect(flat).toContain(`<span>Of which overdue</span><span class="num">${fmtMoney(1500, 'USD')}</span>`);
  });
});

describe('a tax row that nets negative', () => {
  it('is printed, so the totals add up', () => {
    // A credit line taxed on its own, beside an untaxed service: the tax row
    // is -10.00, and dropping every row under 0.005 left Subtotal 50.00 and
    // Total 40.00 with nothing between them.
    const client = { id: 'c1', name: 'Maya Chen' };
    const credit = invoice({
      items: [
        { id: 'a', name: 'Service', qty: 1, rate: 100, taxes: [] },
        { id: 'b', name: 'Credit for overcharge', qty: 1, rate: -50, taxes: [{ label: 'VAT', rate: 20 }] },
      ],
      taxes: [],
    });
    const html = paperHTML(credit, client, settings);
    expect(html).toContain('VAT (20%)');
    expect(html).toContain(fmtMoney(-10, 'USD'));
    const spec = docSpec(credit, client, settings, {});
    expect(spec.totals.find((r) => r.label === 'VAT (20%)')?.value).toBe(pdfMoney(-10, 'USD'));
  });
});

describe('the scrollable table', () => {
  const settings = { business: {}, currency: 'USD', taxLabel: 'Tax' };

  it('is a named region, because it is a tab stop', () => {
    // Focusable so a keyboard (or 400% zoom) can reach the last column; a tab
    // stop with no role and no name announces nothing when it gets there.
    const html = paperHTML(invoice(), null, settings, {});
    expect(html).toContain('<div class="paper-table-scroll" tabindex="0" role="region" aria-label="Line items">');
  });

  it('names it in the document’s own language', () => {
    const html = paperHTML(invoice({ language: 'de' }), null, settings, {});
    expect(html).toContain('aria-label="Positionen"');
  });

  it('names the statement’s table for what it lists', () => {
    const html = statementHTML({ id: 'c1', name: 'Maya' }, [], settings, { today: '2026-08-04' });
    expect(html).toContain('<div class="paper-table-scroll" tabindex="0" role="region" aria-label="Open invoices">');
  });
});
