# Ferroxwood · Suivi des demandes

Plateforme de suivi commercial : les leads **Meta** et **site web** remontent depuis le Google Sheet, Ferroxwood suit chaque dossier (contact, devis envoyé, accepté…) et les **relances de devis partent par email** à J+7 puis J+14.

```
Google Sheet ──(Apps Script, toutes les 10 min)──► /api/import ──► Supabase
                                                                   │
                           Interface (public/index.html) ◄─────────┤
                           Passage quotidien 9 h (/api/cron/reminders) ─► Resend ─► email client
```

| Dossier | Rôle |
|---|---|
| `public/index.html` | L'interface (le prototype de Romane, branché sur Supabase) |
| `api/import.js` | Reçoit les lignes du Sheet, ignore les doublons |
| `api/send-email.js` | Envoi d'un email / d'une relance depuis une fiche |
| `api/cron/reminders.js` | Passage quotidien : relances dues + récap par email |
| `api/config.js` | Donne au navigateur l'URL Supabase et la clé publique |
| `lib/core.js` | Règles communes (échéances, modèles d'email, Resend) |
| `supabase/schema.sql` | Tables, sécurité, stockage des PDF |
| `apps-script/Code.gs` | Script à coller dans le Google Sheet |

---

## 1. Supabase (≈ 10 min)

1. Créez un projet sur supabase.com (région **EU – Frankfurt**).
2. **SQL Editor → New query** : collez `supabase/schema.sql` → **Run**.
3. Ajoutez les personnes autorisées (emails en minuscules) :
   ```sql
   insert into public.members (email, name) values
     ('contact@ferroxwood.be', 'Ferroxwood'),
     ('vous@upper-agency.be', 'Upper Agency');
   ```
4. **Authentication → URL Configuration** : *Site URL* = l'adresse Vercel (ex. `https://ferroxwood-suivi.vercel.app`), et ajoutez-la aussi dans *Redirect URLs*.
5. Recommandé : **Authentication → Emails → SMTP Settings**, branchez le SMTP de Resend (même compte qu'à l'étape 2) pour que les liens de connexion arrivent bien (le SMTP par défaut de Supabase est très limité).
6. Notez dans **Project Settings → API** : `Project URL`, `anon public` et `service_role` (secrète).

## 2. Resend — envoi des emails (≈ 10 min + propagation DNS)

1. Compte sur resend.com → **Domains → Add domain** : `ferroxwood.be` (ou un sous-domaine, ex. `mail.ferroxwood.be`).
2. Ajoutez chez l'hébergeur DNS de Ferroxwood les enregistrements affichés (SPF, DKIM, éventuellement DMARC). Attendez le statut **Verified**.
3. **API Keys → Create** (permission *Sending access*).

> Sans domaine vérifié, les relances tombent en spam ou sont refusées.

## 3. Vercel (≈ 5 min)

1. Poussez ce dossier sur un repo GitHub, puis **Vercel → Add New → Project → Import** (preset *Other*, pas de commande de build).
2. **Settings → Environment Variables** :

| Variable | Valeur |
|---|---|
| `SUPABASE_URL` | Project URL Supabase |
| `SUPABASE_ANON_KEY` | clé `anon public` |
| `SUPABASE_SERVICE_ROLE_KEY` | clé `service_role` (**secrète**) |
| `RESEND_API_KEY` | clé Resend |
| `MAIL_FROM` | `Ferroxwood <devis@ferroxwood.be>` |
| `MAIL_REPLY_TO` | boîte de Ferroxwood qui reçoit les réponses clients (ex. `info@ferroxwood.be`) |
| `IMPORT_SECRET` | une longue chaîne aléatoire (même valeur dans l'Apps Script) |
| `CRON_SECRET` | une autre chaîne aléatoire (Vercel l'utilise automatiquement pour la tâche quotidienne) |
| `APP_URL` | l'adresse de la plateforme (lien dans le récap quotidien) |

   Pour générer un secret : `openssl rand -hex 32`.
3. **Redeploy**. La tâche quotidienne est déclarée dans `vercel.json` (`0 7 * * *` = 7 h UTC, soit 9 h en été / 8 h en hiver à Bruxelles).

## 4. Google Sheet (≈ 5 min)

1. Ouvrez le Sheet → **Extensions → Apps Script**, remplacez le contenu par `apps-script/Code.gs`.
2. En haut du fichier, renseignez `ENDPOINT` (`https://VOTRE-APP.vercel.app/api/import`), `SECRET` (= `IMPORT_SECRET`) et les **noms exacts des onglets** dans `SHEETS` (`source: 'Meta'` ou `'Site web'`).
3. Enregistrez, rechargez le Sheet : un menu **Ferroxwood** apparaît.
4. **Ferroxwood → Tester le mapping** : vérifiez que nom, email, téléphone, ville, date sont reconnus. Si une colonne manque, ajoutez son intitulé dans `COLUMNS`. Les colonnes non reconnues (questions du formulaire Meta, etc.) sont recopiées dans le message du dossier.
5. **Synchroniser maintenant** (Google demande d'autoriser le script la première fois), puis **Activer la synchro auto (10 min)**.

Le Sheet reste la porte d'entrée ; **les statuts vivent dans la plateforme** (une ligne déjà importée n'est jamais écrasée).

## 5. Premier test

1. Ouvrez la plateforme, connectez-vous avec un email listé dans `members`.
2. Créez une demande avec **votre propre email**, passez-la en *Devis envoyé* avec une référence, un montant et une date d'envoi il y a 8 jours.
3. **Paramètres → Lancer la vérification maintenant** → la relance apparaît dans *Rappels et relances* → **Préparer → Envoyer**.
4. Dans Paramètres, remplissez *Récap quotidien* avec l'email de Ferroxwood.

## Fonctionnement des relances

- 1re relance à **J+7** après la date d'envoi du devis, 2e à **+7 jours** après la 1re, maximum 2 (délais réglables).
- Stop automatique si le statut change (accepté, refusé, clôturé), si la séquence est suspendue, ou au clic sur **Réponse client reçue**.
- **Mode validation** (par défaut) : les relances dues sont listées, Ferroxwood relit et envoie en un clic. **Mode automatique** : coche dans Paramètres, envoi lors du passage quotidien.
- Le PDF du devis (s'il est ajouté au dossier) est joint aux relances. Les réponses arrivent dans `MAIL_REPLY_TO`.
- Chaque envoi (ou échec) est inscrit dans l'historique du dossier ; un double envoi est bloqué côté serveur.

## Notes

- Sécurité : la base est fermée (RLS), seuls les emails de `members` voient les données. La clé `service_role` n'est utilisée que côté serveur.
- RGPD : les modèles contiennent une phrase « répondez simplement à cet email » pour arrêter les relances ; pensez à mentionner le suivi des devis dans la politique de confidentialité de Ferroxwood.
- Plus tard : brancher directement le webhook Meta Lead Ads et le formulaire du site sur `/api/import` (même format) pour se passer du Sheet.
