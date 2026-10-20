// POST /api/users — gestion des utilisateurs (réservé aux admins)
// Corps : { action: 'list' | 'create' | 'update' | 'remove' | 'set_password', ... }
import { admin, readJson, requireMember, httpError, sendError } from '../lib/core.js';

const ROLES = ['admin', 'commercial'];
const cleanEmail = e => String(e || '').trim().toLowerCase();
const validEmail = e => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e);

async function findAuthUser(db, email) {
  for (let page = 1; page <= 20; page++) {
    const { data, error } = await db.auth.admin.listUsers({ page, perPage: 200 });
    if (error) throw error;
    const u = data.users.find(x => (x.email || '').toLowerCase() === email);
    if (u) return u;
    if (data.users.length < 200) return null;
  }
  return null;
}

async function setPassword(db, email, password) {
  if (String(password || '').length < 8) throw httpError(400, 'Le mot de passe doit faire au moins 8 caractères');
  const existing = await findAuthUser(db, email);
  if (existing) {
    const { error } = await db.auth.admin.updateUserById(existing.id, { password, email_confirm: true });
    if (error) throw error;
  } else {
    const { error } = await db.auth.admin.createUser({ email, password, email_confirm: true });
    if (error) throw error;
  }
}

async function adminCount(db) {
  const { count } = await db.from('members').select('email', { count: 'exact', head: true }).eq('role', 'admin');
  return count || 0;
}

export default async function handler(req, res) {
  try {
    if (req.method !== 'POST') throw httpError(405, 'POST uniquement');
    const db = admin();
    const me = await requireMember(req, db);
    const { data: meRow } = await db.from('members').select('role').eq('email', me.email).single();
    if (meRow?.role !== 'admin') throw httpError(403, 'Réservé aux administrateurs');

    const body = await readJson(req);
    const email = cleanEmail(body.email);

    if (body.action === 'list') {
      const { data, error } = await db.from('members').select('email, name, role, created_at, added_by').order('created_at');
      if (error) throw error;
      const users = [];
      for (let page = 1; page <= 20; page++) {
        const { data: d } = await db.auth.admin.listUsers({ page, perPage: 200 });
        users.push(...(d?.users || []));
        if (!d || d.users.length < 200) break;
      }
      const byEmail = Object.fromEntries(users.map(u => [(u.email || '').toLowerCase(), u]));
      return res.json({
        members: data.map(m => ({ ...m, last_sign_in_at: byEmail[m.email]?.last_sign_in_at || null, has_account: !!byEmail[m.email] }))
      });
    }

    if (!validEmail(email)) throw httpError(400, 'Adresse email invalide');

    if (body.action === 'create') {
      const role = ROLES.includes(body.role) ? body.role : 'commercial';
      const name = String(body.name || '').trim() || null;
      const { error } = await db.from('members').upsert({ email, name, role, added_by: me.email }, { onConflict: 'email' });
      if (error) throw error;
      if (body.password) await setPassword(db, email, body.password);
      else if (!(await findAuthUser(db, email))) {             // compte sans mot de passe : connexion par lien email
        const { error: ce } = await db.auth.admin.createUser({ email, email_confirm: true });
        if (ce) throw ce;
      }
      return res.json({ ok: true });
    }

    if (body.action === 'update') {
      const patch = {};
      if (body.name !== undefined) patch.name = String(body.name || '').trim() || null;
      if (body.role !== undefined) {
        if (!ROLES.includes(body.role)) throw httpError(400, 'Rôle inconnu');
        if (body.role !== 'admin' && email === me.email && (await adminCount(db)) <= 1) throw httpError(400, 'Il doit rester au moins un administrateur');
        patch.role = body.role;
      }
      const { error } = await db.from('members').update(patch).eq('email', email);
      if (error) throw error;
      return res.json({ ok: true });
    }

    if (body.action === 'set_password') {
      const { data: m } = await db.from('members').select('email').eq('email', email).maybeSingle();
      if (!m) throw httpError(404, 'Utilisateur inconnu');
      await setPassword(db, email, body.password);
      return res.json({ ok: true });
    }

    if (body.action === 'remove') {
      if (email === me.email) throw httpError(400, 'Vous ne pouvez pas retirer votre propre accès');
      const { error } = await db.from('members').delete().eq('email', email);
      if (error) throw error;
      const u = await findAuthUser(db, email);
      if (u) await db.auth.admin.deleteUser(u.id);   // coupe aussi les sessions en cours
      return res.json({ ok: true });
    }

    throw httpError(400, 'Action inconnue');
  } catch (e) { sendError(res, e); }
}
