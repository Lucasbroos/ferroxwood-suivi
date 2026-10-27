// POST /api/quote — établir / modifier le devis d'un dossier et générer son PDF
// Corps : { leadId, quoteId?, lines:[{description, qty, unit, price}], vatRate, depositPct, validityDays, notes }
// Réponse : { quote, url } (url = lien temporaire vers le PDF)
import { admin, readJson, requireMember, httpError, sendError, todayBE, addDays } from '../lib/core.js';
import { buildQuotePdf, computeTotals } from '../lib/quote-pdf.js';

export default async function handler(req, res) {
  try {
    if (req.method !== 'POST') throw httpError(405, 'POST uniquement');
    const db = admin();
    const user = await requireMember(req, db);
    const b = await readJson(req);

    const { data: lead } = await db.from('leads').select('*').eq('id', b.leadId).maybeSingle();
    if (!lead) throw httpError(404, 'Dossier introuvable');
    const { data: s } = await db.from('settings').select('*').eq('id', 1).single();

    const lines = (Array.isArray(b.lines) ? b.lines : [])
      .map(l => ({
        description: String(l.description || '').trim().slice(0, 2000),
        qty: Number(String(l.qty ?? '').replace(',', '.')) || 0,
        unit: String(l.unit || '').trim().slice(0, 20),
        price: Number(String(l.price ?? '').replace(',', '.')) || 0
      }))
      .filter(l => l.description || l.price);
    if (!lines.length) throw httpError(400, 'Ajoutez au moins une ligne au devis');

    const vat_rate = [0, 6, 21].includes(Number(b.vatRate)) ? Number(b.vatRate) : Number(s.quote_vat_default ?? 21);
    const deposit_pct = Math.min(100, Math.max(0, Number(b.depositPct ?? s.quote_deposit_pct ?? 0) || 0));
    const validity = Math.max(1, Number(b.validityDays ?? s.quote_validity_days ?? 30) || 30);
    const issued_on = todayBE();
    const t = computeTotals(lines, vat_rate, deposit_pct);

    const fields = {
      lead_id: lead.id, lines, vat_rate, deposit_pct, notes: String(b.notes || '').trim() || null,
      issued_on, valid_until: addDays(issued_on, validity),
      total_htva: t.htva, total_vat: t.vat, total_tvac: t.tvac, updated_at: new Date().toISOString()
    };

    // Modification d'un devis existant de ce dossier, sinon nouveau numéro DEV-AAAA-NNN
    let quote = null;
    if (b.quoteId) {
      const { data } = await db.from('quotes').select('*').eq('id', b.quoteId).eq('lead_id', lead.id).maybeSingle();
      quote = data;
    }
    if (quote) {
      const { data, error } = await db.from('quotes').update(fields).eq('id', quote.id).select('*').single();
      if (error) throw error;
      quote = data;
    } else {
      const year = Number(issued_on.slice(0, 4));
      for (let attempt = 0; attempt < 5 && !quote; attempt++) {
        const { data: last } = await db.from('quotes').select('seq').eq('year', year).order('seq', { ascending: false }).limit(1);
        const seq = (last?.[0]?.seq || 0) + 1;
        const number = `DEV-${year}-${String(seq).padStart(3, '0')}`;
        const { data, error } = await db.from('quotes').insert({ ...fields, year, seq, number, created_by: user.email }).select('*').single();
        if (!error) quote = data;
        else if (!/duplicate|unique/i.test(error.message)) throw error;
      }
      if (!quote) throw httpError(500, 'Impossible d’attribuer un numéro de devis, réessayez');
    }

    // PDF
    const pdf = await buildQuotePdf({ quote, lead, company: s });
    const path = `${lead.id}/${quote.number}.pdf`;
    const up = await db.storage.from('devis').upload(path, pdf, { contentType: 'application/pdf', upsert: true });
    if (up.error) throw up.error;
    await db.from('quotes').update({ pdf_path: path }).eq('id', quote.id);
    await db.from('leads').update({
      quote_id: quote.id, quote_ref: quote.number, amount: t.tvac,
      pdf_path: path, pdf_name: `Devis ${quote.number} - ${s.company_name || 'Ferroxwood'}.pdf`,
      updated_at: new Date().toISOString()
    }).eq('id', lead.id);
    await db.from('lead_events').insert({
      lead_id: lead.id, author: user.email,
      text: `${b.quoteId ? 'Devis modifié' : 'Devis établi'} : ${quote.number} · ${t.tvac.toFixed(2).replace('.', ',')} € TVAC`
    });

    const { data: signed } = await db.storage.from('devis').createSignedUrl(path, 3600);
    res.json({ quote: { ...quote, pdf_path: path }, url: signed?.signedUrl || null });
  } catch (e) { sendError(res, e); }
}
