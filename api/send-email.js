// POST /api/send-email — envoi d'un email / d'une relance depuis la fiche (utilisateur connecté)
// Corps : { leadId, subject, body, isReminder }
import { admin, readJson, requireMember, httpError, sendError, sendLeadEmail } from '../lib/core.js';

export default async function handler(req, res) {
  try {
    if (req.method !== 'POST') throw httpError(405, 'POST uniquement');
    const db = admin();
    const user = await requireMember(req, db);
    const { leadId, subject, body, isReminder } = await readJson(req);
    if (!leadId || !String(subject || '').trim() || !String(body || '').trim()) throw httpError(400, 'Objet et message requis');

    const [{ data: lead }, { data: s }] = await Promise.all([
      db.from('leads').select('*').eq('id', leadId).maybeSingle(),
      db.from('settings').select('*').eq('id', 1).single()
    ]);
    if (!lead) throw httpError(404, 'Dossier introuvable');

    const reminder = !!isReminder && lead.status === 'Devis envoyé' && (lead.reminders || 0) < 2;
    await sendLeadEmail(db, lead, s, { subject: String(subject).trim(), text: String(body), isReminder: reminder, author: user.email });
    res.json({ ok: true });
  } catch (e) { sendError(res, e); }
}
