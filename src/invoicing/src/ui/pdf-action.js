/**
 * Saving paper as a PDF file, loaded on first use.
 *
 * The generator and the spec builder are dynamic imports, so the bytes only
 * arrive for people who actually ask for a PDF and the app's first paint
 * carries none of it.
 */

import { toast } from './toast.js';

let modules = null;

async function load() {
  if (!modules) {
    const [pdf, spec] = await Promise.all([
      import('../lib/pdf.js'),
      import('../lib/pdf-spec.js'),
    ]);
    modules = { ...pdf, ...spec };
  }
  return modules;
}

/**
 * savePdf((mods) => spec) — build the spec once the modules are here, render
 * it, and save it. Reports failure rather than leaving a dead button.
 */
export async function savePdf(build) {
  const pending = toast('Building the PDF…', { icon: 'download', duration: 15000 });
  try {
    const mods = await load();
    const spec = build(mods);
    // The bundled PDF writer uses WinAnsi fonts and cannot shape Arabic.
    // Browser printing can shape Arabic with system fonts, so preserve the
    // actual text and ask the browser to Save as PDF rather than corrupting it.
    if (spec?.language === 'ar') {
      pending.dismiss();
      toast('Arabic paper: choose “Save as PDF” in the print dialog', { icon: 'printer', duration: 8000 });
      window.print();
      return null;
    }
    const name = await mods.downloadPdf(spec);
    pending.dismiss();
    toast(`${name} saved`, { icon: 'circleCheck' });
    return name;
  } catch (err) {
    pending.dismiss();
    console.error(err);
    toast('Could not build the PDF. Print to PDF instead', { icon: 'alert' });
    return null;
  }
}
