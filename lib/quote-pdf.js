// Génération du devis PDF (A4) aux couleurs de Ferroxwood
import { PDFDocument, StandardFonts, rgb } from 'pdf-lib';
import { LOGO_PNG_BASE64 } from './logo.js';

const INK = rgb(0.13, 0.13, 0.13), MUTED = rgb(0.42, 0.42, 0.42), LINE = rgb(0.88, 0.86, 0.80);
const SAND = rgb(0.945, 0.839, 0.541), SAND_LIGHT = rgb(0.98, 0.957, 0.886), DARK = rgb(0.13, 0.13, 0.13);

// Les polices standard PDF ne connaissent que l'alphabet latin courant (WinAnsi)
const SAFE = /[^\x20-\x7E -ÿ€–—‘’“”•…\n]/g;
const clean = s => String(s ?? '').replace(/\r/g, '').replace(/\t/g, ' ').replace(/ /g, ' ').replace(SAFE, '');

export const eur = v => new Intl.NumberFormat('fr-BE', { style: 'currency', currency: 'EUR', minimumFractionDigits: 2 })
  .format(Number(v) || 0).replace(/ | /g, ' ');
const num = v => new Intl.NumberFormat('fr-BE', { maximumFractionDigits: 2 }).format(Number(v) || 0).replace(/ | /g, ' ');
const frDate = iso => iso ? new Date(String(iso).slice(0, 10) + 'T12:00:00Z').toLocaleDateString('fr-BE', { timeZone: 'UTC' }) : '';

export function computeTotals(lines, vatRate, depositPct) {
  const htva = round2((lines || []).reduce((s, l) => s + (Number(l.qty) || 0) * (Number(l.price) || 0), 0));
  const vat = round2(htva * (Number(vatRate) || 0) / 100);
  const tvac = round2(htva + vat);
  const deposit = round2(tvac * (Number(depositPct) || 0) / 100);
  return { htva, vat, tvac, deposit };
}
const round2 = v => Math.round(v * 100) / 100;

function wrap(text, font, size, width) {
  const out = [];
  for (const para of clean(text).split('\n')) {
    if (!para.trim()) { out.push(''); continue; }
    let line = '';
    for (const word of para.split(/ +/)) {
      const test = line ? line + ' ' + word : word;
      if (font.widthOfTextAtSize(test, size) <= width) { line = test; continue; }
      if (line) out.push(line);
      // mot trop long : on le coupe
      let w = word;
      while (font.widthOfTextAtSize(w, size) > width) {
        let i = w.length; while (i > 1 && font.widthOfTextAtSize(w.slice(0, i), size) > width) i--;
        out.push(w.slice(0, i)); w = w.slice(i);
      }
      line = w;
    }
    out.push(line);
  }
  return out;
}

export async function buildQuotePdf({ quote, lead, company }) {
  const pdf = await PDFDocument.create();
  pdf.setTitle(`Devis ${quote.number} – ${company.company_name || 'Ferroxwood'}`);
  pdf.setAuthor(company.company_name || 'Ferroxwood');
  const font = await pdf.embedFont(StandardFonts.Helvetica);
  const bold = await pdf.embedFont(StandardFonts.HelveticaBold);
  const logo = await pdf.embedPng(Buffer.from(LOGO_PNG_BASE64, 'base64'));

  const W = 595.28, H = 841.89, M = 48, CW = W - 2 * M;
  let page, y;
  const pages = [];
  const text = (t, x, yy, { size = 10, f = font, color = INK } = {}) => page.drawText(clean(t), { x, y: yy, size, font: f, color });
  const right = (t, xr, yy, opts = {}) => { const f = opts.f || font, s = opts.size || 10; text(t, xr - f.widthOfTextAtSize(clean(t), s), yy, opts); };

  function newPage(first) {
    page = pdf.addPage([W, H]); pages.push(page);
    if (first) {
      const lh = 78, lw = lh * logo.width / logo.height;
      page.drawImage(logo, { x: M, y: H - M - lh, width: lw, height: lh });
      // coordonnées entreprise (à droite)
      let yy = H - M - 10;
      right(company.company_name || 'Ferroxwood', W - M, yy, { f: bold, size: 13 }); yy -= 15;
      const info = [
        ...String(company.company_address || '').split('\n'),
        company.company_phone && 'Tél. ' + company.company_phone,
        company.company_email, company.company_website,
        company.company_vat && 'TVA ' + company.company_vat
      ].filter(Boolean);
      for (const l of info) { right(l, W - M, yy, { size: 9, color: MUTED }); yy -= 12; }
      y = H - M - lh - 28;
    } else {
      y = H - M;
      text(`Devis ${quote.number} (suite)`, M, y - 4, { f: bold, size: 10, color: MUTED });
      y -= 26;
    }
  }
  newPage(true);

  // Bandeau titre
  page.drawRectangle({ x: M, y: y - 44, width: CW, height: 44, color: DARK });
  text('DEVIS', M + 16, y - 29, { f: bold, size: 20, color: SAND });
  right(`N° ${quote.number}`, W - M - 16, y - 21, { f: bold, size: 12, color: rgb(1, 1, 1) });
  right(`Date : ${frDate(quote.issued_on)}${quote.valid_until ? '   ·   Valable jusqu’au ' + frDate(quote.valid_until) : ''}`,
    W - M - 16, y - 35, { size: 9, color: rgb(0.85, 0.85, 0.85) });
  y -= 70;

  // Bloc client + projet
  const colW = (CW - 20) / 2;
  page.drawRectangle({ x: M, y: y - 74, width: colW, height: 80, color: SAND_LIGHT });
  page.drawRectangle({ x: M + colW + 20, y: y - 74, width: colW, height: 80, color: SAND_LIGHT });
  text('CLIENT', M + 12, y - 10, { f: bold, size: 8, color: MUTED });
  let cy = y - 26;
  for (const l of [lead.name, lead.city, lead.phone, lead.email].filter(Boolean).slice(0, 4)) {
    text(wrap(l, cy === y - 26 ? bold : font, 10, colW - 24)[0], M + 12, cy, { f: cy === y - 26 ? bold : font, size: 10 }); cy -= 13;
  }
  text('PROJET', M + colW + 32, y - 10, { f: bold, size: 8, color: MUTED });
  let py = y - 26;
  for (const l of wrap(lead.project || lead.type || '', font, 10, colW - 24).slice(0, 4)) { text(l, M + colW + 32, py); py -= 13; }
  y -= 104;

  // Tableau des lignes
  const cols = { desc: M + 10, qty: M + CW * 0.56, unit: M + CW * 0.625, pu: M + CW * 0.78, tot: W - M - 10 };
  const descW = CW * 0.56 - 24;
  const header = () => {
    page.drawRectangle({ x: M, y: y - 22, width: CW, height: 22, color: SAND });
    text('Description', cols.desc, y - 15, { f: bold, size: 9 });
    right('Qté', cols.qty + 22, y - 15, { f: bold, size: 9 });
    text('Unité', cols.unit, y - 15, { f: bold, size: 9 });
    right('PU HTVA', cols.pu + 20, y - 15, { f: bold, size: 9 });
    right('Total HTVA', cols.tot, y - 15, { f: bold, size: 9 });
    y -= 22;
  };
  header();
  for (const l of quote.lines || []) {
    const rows = wrap(l.description || '', font, 9.5, descW);
    const h = Math.max(1, rows.length) * 12.5 + 12;
    if (y - h < 190) { newPage(false); header(); }
    let ry = y - 15;
    rows.forEach((r, i) => { text(r, cols.desc, ry - i * 12.5, { size: 9.5, f: i === 0 ? bold : font }); });
    right(num(l.qty), cols.qty + 22, ry, { size: 9.5 });
    text(clean(l.unit || ''), cols.unit, ry, { size: 9.5 });
    right(eur(l.price), cols.pu + 20, ry, { size: 9.5 });
    right(eur((Number(l.qty) || 0) * (Number(l.price) || 0)), cols.tot, ry, { size: 9.5, f: bold });
    y -= h;
    page.drawLine({ start: { x: M, y }, end: { x: W - M, y }, thickness: 0.6, color: LINE });
  }

  // Totaux
  const t = computeTotals(quote.lines, quote.vat_rate, quote.deposit_pct);
  if (y < 230) newPage(false);
  y -= 16;
  const tx = W - M - 230;
  const totalRow = (label, value, strong) => {
    if (strong) page.drawRectangle({ x: tx - 10, y: y - 8, width: 240, height: 24, color: DARK });
    text(label, tx, y, { f: strong ? bold : font, size: strong ? 11 : 10, color: strong ? SAND : INK });
    right(value, W - M - 10, y, { f: bold, size: strong ? 11 : 10, color: strong ? rgb(1, 1, 1) : INK });
    y -= strong ? 28 : 17;
  };
  totalRow('Total HTVA', eur(t.htva));
  totalRow(`TVA ${num(quote.vat_rate)} %`, eur(t.vat));
  y -= 4;
  totalRow('TOTAL TVAC', eur(t.tvac), true);
  if (Number(quote.deposit_pct) > 0) totalRow(`Acompte à la commande (${num(quote.deposit_pct)} %)`, eur(t.deposit));
  if (Number(quote.vat_rate) === 6) {
    y -= 2;
    for (const l of wrap('TVA 6 % : rénovation d’un logement privé de plus de 10 ans, sur attestation du client.', font, 8, 240))
    { text(l, tx, y, { size: 8, color: MUTED }); y -= 10; }
  }

  // Remarques + conditions
  const blocks = [['Remarques', quote.notes], ['Conditions', company.quote_conditions]].filter(b => String(b[1] || '').trim());
  y -= 12;
  for (const [title, body] of blocks) {
    const rows = wrap(body, font, 9, CW);
    if (y - 16 - rows.length * 11.5 < 120) newPage(false);
    text(title.toUpperCase(), M, y, { f: bold, size: 8, color: MUTED }); y -= 14;
    for (const r of rows) { text(r, M, y, { size: 9 }); y -= 11.5; }
    y -= 10;
  }

  // Bon pour accord
  if (y < 140) newPage(false);
  y -= 6;
  page.drawRectangle({ x: M, y: y - 62, width: CW / 2 - 10, height: 62, borderColor: LINE, borderWidth: 1 });
  text('Bon pour accord (date et signature du client)', M + 10, y - 14, { size: 8.5, color: MUTED });
  if (company.company_iban) {
    text('Paiement', M + CW / 2 + 10, y - 14, { f: bold, size: 8.5, color: MUTED });
    text(`IBAN ${company.company_iban}`, M + CW / 2 + 10, y - 28, { size: 9 });
    text(`Communication : ${quote.number}`, M + CW / 2 + 10, y - 41, { size: 9 });
  }

  // Pied de page sur chaque page
  pages.forEach((p, i) => {
    p.drawLine({ start: { x: M, y: 40 }, end: { x: W - M, y: 40 }, thickness: 0.6, color: LINE });
    const foot = [company.company_name, company.company_vat && 'TVA ' + company.company_vat, company.company_iban && 'IBAN ' + company.company_iban, company.company_website]
      .filter(Boolean).join('  ·  ');
    p.drawText(clean(foot), { x: M, y: 27, size: 7.5, font, color: MUTED });
    const pg = `${i + 1} / ${pages.length}`;
    p.drawText(pg, { x: W - M - font.widthOfTextAtSize(pg, 7.5), y: 27, size: 7.5, font, color: MUTED });
  });

  return Buffer.from(await pdf.save());
}
