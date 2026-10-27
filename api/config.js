// GET /api/config — paramètres publics pour le navigateur (jamais la clé service_role)
import { mailConfigured } from '../lib/core.js';

export default function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  res.json({
    supabaseUrl: process.env.SUPABASE_URL || '',
    supabaseAnonKey: process.env.SUPABASE_ANON_KEY || '',
    mail: mailConfigured(),
    mailFrom: process.env.MAIL_FROM || '',
    inbound: !!(process.env.REPLY_DOMAIN && process.env.RESEND_WEBHOOK_SECRET),
    replyDomain: process.env.REPLY_DOMAIN || ''
  });
}
