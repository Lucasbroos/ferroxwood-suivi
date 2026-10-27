// /api/cron/reminders — tâche quotidienne (Vercel Cron, voir vercel.json)
// Peut aussi être lancée depuis Paramètres > « Lancer la vérification maintenant ».
//  - auto_send = true  → envoie les relances arrivées à échéance
//  - auto_send = false → les laisse « à valider » dans la plateforme
//  - envoie un récap à notify_email (nouvelles demandes, relances, actions en retard)
import {
  admin, requireMember, safeEqual, sendError, todayBE, dueDate, reminderTemplate,
  sendLeadEmail, sendMail, mailConfigured, CLOSED, frDate
} from '../../lib/core.js';

export default async function handler(req, res) {
  try {
    const db = admin();
    const auth = String(req.headers.authorization || '');
    const fromCron = process.env.CRON_SECRET && safeEqual(auth, `Bearer ${process.env.CRON_SECRET}`);
    const by = fromCron ? 'Relance automatique' : (await requireMember(req, db)).email;

    const { data: s, error: se } = await db.from('settings').select('*').eq('id', 1).single();
    if (se) throw se;
    const { data: leads, error: le } = await db.from('leads').select('*');
    const { data: templates } = await db.from('email_templates').select('*');
    if (le) throw le;

    const t = todayBE();
    const due = leads.filter(l => { const d = dueDate(l, s); return d && d <= t; });
    const sent = [], failed = [], pending = [];

    if (s.auto_send && mailConfigured()) {
      for (const l of due) {
        const { subject, body } = reminderTemplate(l, s, templates || []);
        try { await sendLeadEmail(db, l, s, { subject, text: body, isReminder: true, author: 'Relance automatique' }); sent.push(l); }
        catch (e) { failed.push({ l, error: e.message }); }
      }
    } else pending.push(...due);

    const since = Date.now() - 24 * 3600 * 1000;
    const fresh = leads.filter(l => l.source !== 'Ajout manuel' && new Date(l.created_at).getTime() >= since);
    const late = leads.filter(l => l.next_on && l.next_on <= t && !CLOSED.includes(l.status));

    let digest = false;
    const to = String(s.notify_email || '').split(',').map(x => x.trim()).filter(Boolean);
    if (fromCron && to.length && mailConfigured() && (sent.length || failed.length || pending.length || fresh.length || late.length)) {
      const app = process.env.APP_URL || '';
      const line = l => `• ${l.name} — ${l.project}`;
      const parts = [`Bonjour,\n\nVoici le point du ${frDate(t)} sur vos demandes.`];
      if (fresh.length) parts.push(`NOUVELLES DEMANDES (24 h) : ${fresh.length}\n` + fresh.map(l => `${line(l)} · ${l.source}`).join('\n'));
      if (pending.length) parts.push(`RELANCES À VALIDER : ${pending.length}\n` + pending.map(l => `${line(l)} · devis ${l.quote_ref || ''} du ${frDate(l.sent_on)}`).join('\n'));
      if (sent.length) parts.push(`RELANCES ENVOYÉES AUTOMATIQUEMENT : ${sent.length}\n` + sent.map(line).join('\n'));
      if (failed.length) parts.push(`ÉCHECS D’ENVOI : ${failed.length}\n` + failed.map(f => `${line(f.l)} · ${f.error}`).join('\n'));
      if (late.length) parts.push(`ACTIONS PRÉVUES OU EN RETARD : ${late.length}\n` + late.map(l => `${line(l)} · ${l.next_action || 'Rappel'} (${frDate(l.next_on)})`).join('\n'));
      if (app) parts.push(`Ouvrir la plateforme : ${app}`);
      try {
        await sendMail({ to, subject: `Ferroxwood · ${fresh.length} nouvelle(s) demande(s), ${pending.length + sent.length} relance(s)`, text: parts.join('\n\n') });
        digest = true;
      } catch (e) { console.error('Récap non envoyé', e); }
    }

    await db.from('settings').update({ last_cron_at: new Date().toISOString() }).eq('id', 1);
    res.json({ by, due: due.length, sent: sent.length, pending: pending.length, failed: failed.length, newLeads: fresh.length, digest });
  } catch (e) { sendError(res, e); }
}
