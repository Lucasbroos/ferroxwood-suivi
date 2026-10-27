// POST /api/inbound — webhook Resend « email.received »
// Un client répond à un email envoyé depuis la plateforme (adresse fw42-xxxx@REPLY_DOMAIN) :
//  1. on vérifie la signature du webhook (RESEND_WEBHOOK_SECRET)
//  2. on récupère le contenu + les pièces jointes chez Resend
//  3. on range la réponse dans le dossier, on stoppe les relances, statut « Échange en cours »
//  4. on envoie une copie à la boîte de Ferroxwood (+ au responsable du dossier)
import { Webhook } from 'svix';
import { admin, httpError, parseReplyAddress, sendMail, CLOSED } from '../lib/core.js';

const json = (status, body) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

async function resendGet(path) {
  const r = await fetch('https://api.resend.com' + path, { headers: { Authorization: `Bearer ${process.env.RESEND_API_KEY}` } });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw httpError(502, `Resend ${path} : ${j.message || r.status}`);
  return j;
}

function decodeMaybeDataUri(v) {
  const s = String(v || '');
  const m = s.match(/^data:[^;,]*(;base64)?,(.*)$/s);
  if (!m) return s;
  return m[1] ? Buffer.from(m[2], 'base64').toString('utf8') : decodeURIComponent(m[2]);
}

function htmlToText(html) {
  return decodeMaybeDataUri(html)
    .replace(/<(style|script)[\s\S]*?<\/\1>/gi, '')
    .replace(/<br\s*\/?>/gi, '\n').replace(/<\/(p|div|tr|li|h\d)>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'")
    .replace(/\n{3,}/g, '\n\n').trim();
}

// Garde la réponse, coupe l'historique cité en dessous (« Le … a écrit : », lignes « > … »)
function stripQuoted(text) {
  const lines = String(text || '').replace(/\r/g, '').split('\n');
  const out = [];
  for (const l of lines) {
    if (/^\s*>/.test(l)) break;
    if (/^\s*(Le|On)\s.+(a écrit|wrote)\s*:?\s*$/i.test(l)) break;
    if (/^\s*-{2,}\s*(Original Message|Message d'origine|Message original)/i.test(l)) break;
    if (/^\s*(De|From)\s*:\s.+/i.test(l) && out.length) break;
    out.push(l);
  }
  const r = out.join('\n').trim();
  return r || String(text || '').trim();
}

const addrOf = v => (String(v || '').match(/<([^>]+)>/) || [, String(v || '')])[1].trim().toLowerCase();

export async function POST(request) {
  try {
    const secret = process.env.RESEND_WEBHOOK_SECRET;
    if (!secret) throw httpError(500, 'RESEND_WEBHOOK_SECRET manquant');
    const raw = await request.text();
    let event;
    try {
      event = new Webhook(secret).verify(raw, {
        'svix-id': request.headers.get('svix-id'),
        'svix-timestamp': request.headers.get('svix-timestamp'),
        'svix-signature': request.headers.get('svix-signature'),
      });
    } catch { throw httpError(401, 'Signature du webhook invalide'); }

    if (event?.type !== 'email.received') return json(200, { ignored: event?.type || 'unknown' });
    const d = event.data || {};
    const db = admin();

    // Doublon (Resend peut renvoyer le même webhook)
    const { data: dup } = await db.from('lead_messages').select('id').eq('resend_id', d.email_id).maybeSingle();
    if (dup) return json(200, { duplicate: true });

    // 1. Retrouver le dossier : adresse fw42-xxxx@…, sinon email de l'expéditeur
    const recipients = [].concat(d.to || [], d.received_for || [], d.cc || []).map(addrOf);
    const from = addrOf(d.from);
    let lead = null;
    for (const r of recipients) {
      const p = parseReplyAddress(r);
      if (!p) continue;
      const { data } = await db.from('leads').select('*').eq('number', p.number).maybeSingle();
      if (data && String(data.id).replace(/-/g, '').startsWith(p.idPrefix)) { lead = data; break; }
    }
    if (!lead && from) {
      const { data } = await db.from('leads').select('*').eq('email', from).order('created_at', { ascending: false }).limit(1);
      lead = data?.[0] || null;
    }

    // 2. Contenu + pièces jointes
    const mail = await resendGet(`/emails/receiving/${d.email_id}`);
    const full = mail.text ? String(mail.text) : htmlToText(mail.html);
    const body = stripQuoted(full).slice(0, 20000);
    const subject = String(mail.subject || d.subject || '(sans objet)').slice(0, 300);

    const stored = [], forwardFiles = [];
    let totalForward = 0;
    if ((d.attachments || []).length) {
      const list = await resendGet(`/emails/receiving/${d.email_id}/attachments`).catch(() => ({ data: [] }));
      for (const a of (list.data || []).slice(0, 15)) {
        if (a.content_disposition === 'inline' && /^image\//.test(a.content_type || '') && (a.size || 0) < 15000) continue; // logos de signature
        try {
          const r = await fetch(a.download_url);
          if (!r.ok) continue;
          const buf = Buffer.from(await r.arrayBuffer());
          const safe = String(a.filename || 'fichier').replace(/[^\w.\-]+/g, '_').slice(-120);
          const path = `${lead ? lead.id : 'sans-dossier'}/${Date.now()}-${safe}`;
          const up = await db.storage.from('pieces').upload(path, buf, { contentType: a.content_type || 'application/octet-stream' });
          if (!up.error) stored.push({ name: a.filename || safe, path, type: a.content_type || '', size: buf.length });
          if (totalForward + buf.length < 15 * 1024 * 1024) {
            forwardFiles.push({ filename: a.filename || safe, content: buf.toString('base64') });
            totalForward += buf.length;
          }
        } catch (e) { console.error('Pièce jointe ignorée', a.filename, e); }
      }
    }

    // 3. Ranger dans le dossier + effets automatiques
    if (lead) {
      await db.from('lead_messages').insert({
        lead_id: lead.id, direction: 'in', from_email: from, to_email: recipients[0] || null,
        subject, body, attachments: stored, resend_id: d.email_id, author: from, read: false
      });
      const patch = { suspended: true, updated_at: new Date().toISOString() };
      if (!CLOSED.includes(lead.status)) patch.status = 'Échange en cours';
      await db.from('leads').update(patch).eq('id', lead.id);
      await db.from('lead_events').insert({
        lead_id: lead.id, author: from,
        text: `Réponse du client reçue par email · « ${subject} »` + (stored.length ? ` · ${stored.length} pièce(s) jointe(s)` : '') +
          (lead.status === 'Devis envoyé' ? ' · relances arrêtées' : '')
      });
    }

    // 4. Copie vers la boîte de Ferroxwood (+ responsable du dossier)
    const to = new Set(String(process.env.FORWARD_TO || process.env.MAIL_REPLY_TO || '').split(',').map(x => x.trim().toLowerCase()).filter(Boolean));
    if (lead?.owner) {
      const { data: m } = await db.from('members').select('email').eq('name', lead.owner).maybeSingle();
      if (m?.email) to.add(m.email);
    }
    if (to.size) {
      const app = process.env.APP_URL || '';
      const code = lead ? 'FW-' + String(lead.number).padStart(3, '0') : 'sans dossier';
      const text = [
        lead ? `Nouvelle réponse de ${lead.name} (${from}) sur le dossier ${code} — ${lead.project}.` :
               `Email reçu de ${from}, non rattaché à un dossier.`,
        lead ? 'La réponse est enregistrée dans la plateforme et les relances de ce dossier sont arrêtées.' : '',
        '',
        '———',
        full.slice(0, 15000),
        '———',
        app ? `Ouvrir la plateforme : ${app}` : '',
        `Pour répondre au client depuis votre messagerie, répondez simplement à cet email (réponse envoyée à ${from}).`
      ].filter(x => x !== null).join('\n');
      try {
        await sendMail({
          to: [...to], subject: `[${code}] ${subject}`, text,
          attachments: forwardFiles, replyTo: from
        });
      } catch (e) { console.error('Copie non envoyée', e); }
    }

    return json(200, { ok: true, lead: lead?.id || null, attachments: stored.length });
  } catch (e) {
    if ((e.status || 500) >= 500) console.error(e);
    return json(e.status || 500, { error: e.message || 'Erreur serveur' });
  }
}
