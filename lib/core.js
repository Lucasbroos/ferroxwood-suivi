// Logique partagée par les routes /api (côté serveur uniquement)
import { createClient } from '@supabase/supabase-js';
import { timingSafeEqual } from 'node:crypto';

export const CLOSED = ['Devis accepté', 'Devis refusé', 'Dossier clôturé'];
export const TYPES = ['Portail', 'Garde-corps', 'Escalier', 'Porte', 'Terrasse suspendue', 'Carport', 'Mobilier', 'Autre'];

export function admin() {
  const url = process.env.SUPABASE_URL, key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) throw httpError(500, 'SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY manquants');
  return createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false } });
}

export function httpError(status, message) { const e = new Error(message); e.status = status; return e; }

export function sendError(res, e) {
  const status = e.status || 500;
  if (status >= 500) console.error(e);
  res.status(status).json({ error: e.message || 'Erreur serveur' });
}

export function safeEqual(a, b) {
  const x = Buffer.from(String(a || '')), y = Buffer.from(String(b || ''));
  return x.length > 0 && x.length === y.length && timingSafeEqual(x, y);
}

export async function readJson(req) {
  if (req.body && typeof req.body === 'object') return req.body;
  if (typeof req.body === 'string') return req.body ? JSON.parse(req.body) : {};
  const chunks = [];
  for await (const c of req) chunks.push(c);
  const s = Buffer.concat(chunks).toString('utf8');
  return s ? JSON.parse(s) : {};
}

// Vérifie le jeton Supabase envoyé par le navigateur + l'appartenance à « members »
export async function requireMember(req, db) {
  const token = String(req.headers.authorization || '').replace(/^Bearer\s+/i, '');
  if (!token) throw httpError(401, 'Non connecté');
  const { data, error } = await db.auth.getUser(token);
  if (error || !data?.user?.email) throw httpError(401, 'Session expirée, reconnectez-vous');
  const email = data.user.email.toLowerCase();
  const { data: m } = await db.from('members').select('email').eq('email', email).maybeSingle();
  if (!m) throw httpError(403, 'Accès non autorisé');
  return { email };
}

// ---------- Dates (fuseau Europe/Brussels, format AAAA-MM-JJ) ----------
export const todayBE = () => new Date().toLocaleDateString('sv-SE', { timeZone: 'Europe/Brussels' });
export function addDays(iso, n) {
  const d = new Date(iso + 'T12:00:00Z');
  d.setUTCDate(d.getUTCDate() + Number(n));
  return d.toISOString().slice(0, 10);
}
export const frDate = iso => iso ? new Date(iso + 'T12:00:00Z').toLocaleDateString('fr-BE', { timeZone: 'UTC' }) : '';
const money = v => v == null || v === '' ? '' :
  new Intl.NumberFormat('fr-BE', { style: 'currency', currency: 'EUR', maximumFractionDigits: 0 }).format(Number(v));

// Même règle que l'interface : 1re relance à J+first_delay après l'envoi,
// 2e à +second_delay après la 1re, maximum 2 relances.
export function dueDate(l, s) {
  if (CLOSED.includes(l.status) || l.suspended || l.status !== 'Devis envoyé' || !l.sent_on || !l.email) return null;
  if ((l.reminders || 0) >= 2) return null;
  if (l.reminder_override_on) return l.reminder_override_on;
  return l.last_reminder_on ? addDays(l.last_reminder_on, s.second_delay) : addDays(l.sent_on, s.first_delay);
}

export function fill(template, l, s) {
  const vars = {
    prenom: String(l.name || '').trim().split(/\s+/)[0] || '',
    nom: l.name || '', projet: l.project || '', ref: l.quote_ref || '',
    type: String(l.type && l.type !== 'Autre' ? l.type : 'projet').toLowerCase(), ville: l.city || '',
    date_envoi: frDate(l.sent_on), montant: money(l.amount), signature: s.signature || ''
  };
  return String(template || '').replace(/\{(\w+)\}/g, (m, k) => (k in vars ? vars[k] : m));
}

export function reminderTemplate(l, s, templates = []) {
  const n = Math.min((l.reminders || 0) + 1, 2);
  const t = templates.find(x => x.kind === `relance${n}`);
  return { subject: fill(t ? t.subject : s[`subject_${n}`], l, s), body: fill(t ? t.body : s[`body_${n}`], l, s) };
}

// ---------- Envoi d'email (Resend) ----------
export const mailConfigured = () => !!(process.env.RESEND_API_KEY && process.env.MAIL_FROM);

// Adresse de réponse propre à chaque dossier : fw42-3f9a1c2b@reply.ferroxwood.be
export const fromName = () => (String(process.env.MAIL_FROM || '').match(/^\s*"?([^"<]+?)"?\s*</) || [])[1] || 'Ferroxwood';
export function replyAddress(lead) {
  const d = String(process.env.REPLY_DOMAIN || '').trim().toLowerCase();
  if (!d || !lead?.id || lead.number == null) return null;
  return `fw${lead.number}-${String(lead.id).replace(/-/g, '').slice(0, 8)}@${d}`;
}
export function parseReplyAddress(addr) {
  const m = String(addr || '').toLowerCase().match(/fw(\d+)-([0-9a-f]{8})@/);
  return m ? { number: Number(m[1]), idPrefix: m[2] } : null;
}

// Version HTML sobre du message texte (meilleure délivrabilité que le texte seul)
export function textToHtml(text) {
  const esc = String(text || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  const body = esc.split(/\n{2,}/).map(p => `<p style="margin:0 0 14px">${p.replace(/\n/g, '<br>')}</p>`).join('');
  return `<!doctype html><html><body style="margin:0;padding:24px;background:#ffffff;font-family:Arial,Helvetica,sans-serif;font-size:15px;line-height:1.55;color:#222222"><div style="max-width:600px">${body}</div></body></html>`;
}

export async function sendMail({ to, subject, text, attachments, replyTo }) {
  if (!mailConfigured()) throw httpError(500, 'Envoi non configuré (RESEND_API_KEY / MAIL_FROM)');
  const r = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: { Authorization: `Bearer ${process.env.RESEND_API_KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      from: process.env.MAIL_FROM,
      to: Array.isArray(to) ? to : [to],
      reply_to: replyTo || process.env.MAIL_REPLY_TO || undefined,
      subject, text, html: textToHtml(text),
      attachments: attachments?.length ? attachments : undefined
    })
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw httpError(502, 'Resend : ' + (j.message || r.status));
  return j.id;
}

// Envoie un email à un client et l'enregistre dans le fil d'échanges du dossier.
//  - isReminder : relance de devis (réservée d'abord pour éviter un double envoi)
//  - isQuote    : envoi du devis (PDF obligatoire) → statut « Devis envoyé » + relances programmées
export async function sendLeadEmail(db, lead, s, { subject, text, isReminder, isQuote, author }) {
  if (!lead.email) throw httpError(400, 'Pas d’adresse email pour ce client');
  if (isQuote && !lead.pdf_path) throw httpError(400, 'Ajoutez d’abord le PDF du devis dans la fiche');
  const n = (lead.reminders || 0) + 1;
  let claimed = false;
  if (isReminder) {
    const { data, error } = await db.from('leads')
      .update({ reminders: n, last_reminder_on: todayBE(), reminder_override_on: null, draft: null, updated_at: new Date().toISOString() })
      .eq('id', lead.id).eq('reminders', lead.reminders || 0).select('id');
    if (error) throw error;
    if (!data?.length) throw httpError(409, 'Cette relance vient déjà d’être envoyée');
    claimed = true;
  }
  try {
    let attachments;
    if ((isQuote || (isReminder && s.attach_pdf)) && lead.pdf_path) {
      const { data: f } = await db.storage.from('devis').download(lead.pdf_path);
      if (f) attachments = [{ filename: lead.pdf_name || 'devis.pdf', content: Buffer.from(await f.arrayBuffer()).toString('base64') }];
      else if (isQuote) throw httpError(400, 'PDF du devis introuvable, ajoutez-le à nouveau');
    }
    const ra = replyAddress(lead);
    const id = await sendMail({ to: lead.email, subject, text, attachments, replyTo: ra ? `${fromName()} <${ra}>` : undefined });

    const label = isQuote ? 'Devis envoyé par email' : isReminder ? `Relance ${n} envoyée par email` : 'Email envoyé';
    await db.from('lead_messages').insert({
      lead_id: lead.id, direction: 'out', from_email: process.env.MAIL_FROM || null, to_email: lead.email,
      subject, body: text, attachments: (attachments || []).map(a => ({ name: a.filename })), resend_id: id || null, author, read: true
    });
    await db.from('lead_events').insert({ lead_id: lead.id, author, text: `${label} · « ${subject} »` });
    if (isQuote) {
      await db.from('leads').update({
        status: 'Devis envoyé', sent_on: todayBE(), reminders: 0, last_reminder_on: null,
        reminder_override_on: null, suspended: false, draft: null, updated_at: new Date().toISOString()
      }).eq('id', lead.id);
      if (lead.quote_id) await db.from('quotes').update({ sent_at: new Date().toISOString() }).eq('id', lead.quote_id);
    } else if (lead.status === 'Nouvelle demande') {
      // Premier contact (accusé de réception…) → le dossier passe « En discussion »
      await db.from('leads').update({ status: 'Échange en cours', draft: null, updated_at: new Date().toISOString() }).eq('id', lead.id);
    }
    return id;
  } catch (e) {
    if (claimed) {
      await db.from('leads').update({
        reminders: lead.reminders || 0, last_reminder_on: lead.last_reminder_on,
        reminder_override_on: lead.reminder_override_on, draft: lead.draft
      }).eq('id', lead.id);
    }
    await db.from('lead_events').insert({ lead_id: lead.id, author, text: 'Échec d’envoi : ' + e.message });
    throw e;
  }
}

// ---------- Normalisation des lignes importées du Sheet ----------
const clean = v => String(v ?? '').trim();

export function detectType(text) {
  const t = clean(text).toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '');
  if (/portail|portillon/.test(t)) return 'Portail';
  if (/garde.?corps|rambarde|balustrade/.test(t)) return 'Garde-corps';
  if (/escalier/.test(t)) return 'Escalier';
  if (/terrasse/.test(t)) return 'Terrasse suspendue';
  if (/carport/.test(t)) return 'Carport';
  if (/porte|verriere/.test(t)) return 'Porte';
  if (/table|meuble|mobilier|etagere/.test(t)) return 'Mobilier';
  return 'Autre';
}

export function parseDate(v) {
  const s = clean(v);
  if (!s) return null;
  let m = s.match(/^(\d{1,2})[/.-](\d{1,2})[/.-](\d{4})/);          // 16/10/2026
  if (m) return `${m[3]}-${m[2].padStart(2, '0')}-${m[1].padStart(2, '0')}`;
  const d = new Date(s);                                              // ISO / Meta created_time
  if (isNaN(d)) return null;
  return d.toLocaleDateString('sv-SE', { timeZone: 'Europe/Brussels' });
}

export function parseBudget(v) {
  const s = clean(v).replace(/\s/g, '').replace(',', '.');
  const m = s.match(/\d+(\.\d+)?/);
  return m ? Math.round(Number(m[0])) : null;
}

export function normalizeLead(x) {
  const type0 = TYPES.includes(clean(x.type)) ? clean(x.type) : detectType([x.type, x.project, x.message].join(' '));
  const name = clean(x.name) || [clean(x.first_name), clean(x.last_name)].filter(Boolean).join(' ') || 'Sans nom';
  const city = clean(x.city) || null;
  const project = clean(x.project) || `${type0 === 'Autre' ? 'Demande' : type0}${city ? ' – ' + city : ''}`;
  return {
    external_id: clean(x.external_id).slice(0, 200),
    source: x.source === 'Meta' ? 'Meta' : 'Site web',
    status: 'Nouvelle demande',
    name: name.slice(0, 200),
    email: clean(x.email).toLowerCase() || null,
    phone: clean(x.phone).replace(/^p:/i, '') || null,
    city, project: project.slice(0, 300), type: type0,
    message: clean(x.message).slice(0, 5000) || null,
    budget: parseBudget(x.budget),
    received_on: parseDate(x.created) || todayBE(),
    raw: x.raw && typeof x.raw === 'object' ? x.raw : null
  };
}
