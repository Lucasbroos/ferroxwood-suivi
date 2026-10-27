// POST /api/import — appelé par le Google Apps Script du Sheet
// En-tête requis : x-import-secret: <IMPORT_SECRET>
// Corps : { leads: [{ external_id, source, name, email, phone, city, message, type, budget, created, raw }] }
import { admin, readJson, safeEqual, httpError, sendError, normalizeLead } from '../lib/core.js';

export default async function handler(req, res) {
  try {
    if (req.method !== 'POST') throw httpError(405, 'POST uniquement');
    if (!safeEqual(req.headers['x-import-secret'], process.env.IMPORT_SECRET)) throw httpError(401, 'Secret invalide');

    const body = await readJson(req);
    const input = Array.isArray(body.leads) ? body.leads : [];
    if (input.length > 500) throw httpError(413, 'Maximum 500 leads par appel');

    const db = admin();
    let rows = input.map(normalizeLead).filter(r => r.external_id);

    // On écarte d'abord les leads déjà importés : sinon chaque tentative d'insertion
    // consomme un numéro de dossier (FW-xxx) même quand elle est ignorée comme doublon.
    const known = new Set();
    const ids = [...new Set(rows.map(r => r.external_id))];
    for (let i = 0; i < ids.length; i += 100) {
      const { data: ex, error: exErr } = await db.from('leads').select('external_id').in('external_id', ids.slice(i, i + 100));
      if (exErr) throw exErr;
      (ex || []).forEach(x => known.add(x.external_id));
    }
    const seen = new Set();
    rows = rows.filter(r => !known.has(r.external_id) && !seen.has(r.external_id) && seen.add(r.external_id));
    if (!rows.length) return res.json({ received: input.length, inserted: 0 });

    // ignoreDuplicates : une ligne déjà importée (même external_id) n'est jamais écrasée,
    // donc les statuts saisis par Ferroxwood restent intacts.
    const { data, error } = await db.from('leads')
      .upsert(rows, { onConflict: 'external_id', ignoreDuplicates: true })
      .select('id, source');
    if (error) throw error;

    if (data?.length) {
      await db.from('lead_events').insert(data.map(l => ({
        lead_id: l.id, text: 'Demande reçue · ' + l.source, author: 'Import Google Sheet'
      })));
    }
    res.json({ received: input.length, inserted: data?.length || 0 });
  } catch (e) { sendError(res, e); }
}
