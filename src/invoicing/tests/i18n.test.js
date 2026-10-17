import { describe, it, expect } from 'vitest';
import { LANGS, STRINGS, docLang, translator } from '../src/lib/i18n.js';

describe('the strings table', () => {
  it('covers every language it offers', () => {
    for (const { code } of LANGS) expect(STRINGS[code], code).toBeTruthy();
  });

  it('carries every English key in every language', () => {
    const keys = Object.keys(STRINGS.en);
    for (const [code, table] of Object.entries(STRINGS)) {
      for (const key of keys) {
        expect(typeof table[key], `${code}.${key}`).toBe('string');
      }
    }
  });

  it('stays within what the PDF fonts can draw', () => {
    // The writer folds text to WinAnsi; anything outside Latin-1 plus the
    // few punctuation marks it maps would print as '?'.
    const drawable = /^[\0-ÿ–—‘’“”…•€™]*$/;
    for (const [code, table] of Object.entries(STRINGS)) {
      for (const [key, value] of Object.entries(table)) {
        expect(drawable.test(value), `${code}.${key}: ${value}`).toBe(true);
      }
    }
  });
});

  it('includes Arabic labels for browser-rendered paper', () => {
    expect(LANGS.some((l) => l.code === 'ar')).toBe(true);
    expect(STRINGS.ar.invoice).toBe('فاتورة');
    expect(STRINGS.ar.total).toBe('الإجمالي');
  });
});

describe('docLang', () => {
  it('prefers the document, then the client, then none', () => {
    expect(docLang({ language: 'de' }, { language: 'fr' })).toBe('de');
    expect(docLang({}, { language: 'fr' })).toBe('fr');
    expect(docLang({}, {})).toBe('');
    expect(docLang(null, null)).toBe('');
  });

  it('reads an unknown code as none rather than failing', () => {
    expect(docLang({ language: 'xx' }, null)).toBe('');
  });

  it('reads a code naming an inherited member as none too', () => {
    // STRINGS.constructor and friends come from Object.prototype; a stored
    // language of 'constructor' used to pass as a real code.
    expect(docLang({ language: 'constructor' }, null)).toBe('');
    expect(docLang({}, { language: 'toString' })).toBe('');
  });
});

describe('translator', () => {
  it('translates and interpolates', () => {
    expect(translator('de')('invoice')).toBe('Rechnung');
    expect(translator('fr')('pageOf', { n: 2, m: 3 })).toBe('Page 2 sur 3');
    expect(translator('')('invoice')).toBe('Invoice');
  });

  it('falls back to English, then to the key itself', () => {
    expect(translator('xx')('invoice')).toBe('Invoice');
    expect(translator('de')('nonexistent-key')).toBe('nonexistent-key');
  });

  it('falls back to English for a language named after an inherited member', () => {
    expect(translator('constructor')('invoice')).toBe('Invoice');
  });
});
