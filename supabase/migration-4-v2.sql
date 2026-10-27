-- =====================================================================
-- Migration 4 · Version simplifiée (5 étapes, modèles d'emails, devis PDF)
-- À exécuter une fois dans Supabase > SQL Editor > New query > Run
-- (après schema.sql, migration-2 et migration-3). Peut être relancé sans risque.
-- =====================================================================

-- 1. Cinq étapes seulement
--    Nouvelle demande → Échange en cours (« En discussion ») → Devis envoyé → Devis accepté (« Gagné ») / Devis refusé (« Perdu »)
alter table public.leads drop constraint if exists leads_status_check;
update public.leads set status = 'Nouvelle demande' where status in ('À contacter');
update public.leads set status = 'Échange en cours'
  where status in ('Contact tenté, sans réponse', 'Informations ou visite à prévoir', 'Devis à préparer');
update public.leads set status = 'Devis refusé' where status in ('Dossier clôturé');
alter table public.leads add constraint leads_status_check
  check (status in ('Nouvelle demande', 'Échange en cours', 'Devis envoyé', 'Devis accepté', 'Devis refusé'));

-- 2. Modèles d'emails (modifiables par toute l'équipe)
create table if not exists public.email_templates (
  id         bigserial primary key,
  kind       text not null check (kind in ('accuse', 'devis', 'relance1', 'relance2', 'libre')),
  name       text not null,
  subject    text not null,
  body       text not null,
  position   integer not null default 100,
  updated_at timestamptz not null default now()
);
alter table public.email_templates enable row level security;
drop policy if exists templates_all on public.email_templates;
create policy templates_all on public.email_templates for all to authenticated
  using (public.is_member()) with check (public.is_member());

insert into public.email_templates (kind, name, subject, body, position)
select * from (values
  ('accuse', 'Accusé de réception – proposer un appel',
   'Votre demande de devis – Ferroxwood',
   E'Bonjour {prenom},\n\nMerci pour votre demande de devis pour votre {type}. Nous l’avons bien reçue et allons vous recontacter très rapidement.\n\nPour préparer un devis précis, quand seriez-vous disponible pour un court appel ? N’hésitez pas à nous indiquer un créneau qui vous arrange.\n\nSi vous avez des photos de l’endroit ou des dimensions approximatives, vous pouvez les envoyer en réponse à cet email.\n\nBelle journée,\n{signature}', 1),
  ('accuse', 'Accusé de réception – demander photos et mesures',
   'Votre demande de devis – quelques informations',
   E'Bonjour {prenom},\n\nMerci pour votre demande, nous l’avons bien reçue.\n\nPour vous faire une offre rapidement, pourriez-vous nous envoyer en réponse à cet email :\n• quelques photos de l’endroit ;\n• les dimensions approximatives ;\n• votre adresse (commune) pour le placement.\n\nNous revenons vers vous dès réception.\n\nBelle journée,\n{signature}', 2),
  ('libre', 'Proposer une visite',
   'Votre projet – visite sur place',
   E'Bonjour {prenom},\n\nPour finaliser votre devis, nous vous proposons une courte visite sur place afin de prendre les mesures.\n\nQuelles disponibilités auriez-vous dans les prochains jours ?\n\nBelle journée,\n{signature}', 10)
) as t(kind, name, subject, body, position)
where not exists (select 1 from public.email_templates);

-- Les modèles « devis » et « relances » reprennent les textes existants des paramètres
insert into public.email_templates (kind, name, subject, body, position)
select 'devis', 'Envoi du devis', s.subject_quote, s.body_quote, 20 from public.settings s
where not exists (select 1 from public.email_templates where kind = 'devis');
insert into public.email_templates (kind, name, subject, body, position)
select 'relance1', 'Relance 1 (automatique)', s.subject_1, s.body_1, 30 from public.settings s
where not exists (select 1 from public.email_templates where kind = 'relance1');
insert into public.email_templates (kind, name, subject, body, position)
select 'relance2', 'Relance 2 (automatique)', s.subject_2, s.body_2, 31 from public.settings s
where not exists (select 1 from public.email_templates where kind = 'relance2');

-- 3. Devis établis dans la plateforme
create table if not exists public.quotes (
  id           uuid primary key default gen_random_uuid(),
  lead_id      uuid not null references public.leads(id) on delete cascade,
  number       text not null unique,                 -- DEV-2026-001
  year         integer not null,
  seq          integer not null,
  issued_on    date not null default (now() at time zone 'Europe/Brussels')::date,
  valid_until  date,
  lines        jsonb not null default '[]'::jsonb,   -- [{ description, qty, unit, price }]
  vat_rate     numeric not null default 21,
  deposit_pct  numeric not null default 0,
  notes        text,
  total_htva   numeric not null default 0,
  total_vat    numeric not null default 0,
  total_tvac   numeric not null default 0,
  pdf_path     text,
  sent_at      timestamptz,
  created_by   text,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now(),
  unique (year, seq)
);
create index if not exists quotes_lead_idx on public.quotes (lead_id, created_at desc);
alter table public.quotes enable row level security;
drop policy if exists quotes_read on public.quotes;
create policy quotes_read on public.quotes for select to authenticated using (public.is_member());

alter table public.leads add column if not exists quote_id uuid references public.quotes(id) on delete set null;

-- 4. Infos entreprise + réglages des devis
alter table public.settings add column if not exists company_name    text not null default 'Ferroxwood';
alter table public.settings add column if not exists company_address text not null default '';
alter table public.settings add column if not exists company_vat     text not null default '';
alter table public.settings add column if not exists company_phone   text not null default '';
alter table public.settings add column if not exists company_email   text not null default 'ferroxwood48@gmail.com';
alter table public.settings add column if not exists company_iban    text not null default '';
alter table public.settings add column if not exists company_website text not null default 'www.ferroxwood.be';
alter table public.settings add column if not exists quote_vat_default   numeric not null default 21;
alter table public.settings add column if not exists quote_deposit_pct   numeric not null default 30;
alter table public.settings add column if not exists quote_validity_days integer not null default 30;
alter table public.settings add column if not exists quote_conditions text not null default
  E'Prix TVAC, fourniture et placement compris sauf mention contraire.\nUn acompte est demandé à la commande ; le solde est payable à la fin du chantier.\nDélai de fabrication communiqué à la commande. Devis valable jusqu’à la date indiquée.';

-- 5. Relances automatiques activées (4 jours puis 7 jours après)
update public.settings set auto_send = true, first_delay = 4, second_delay = 7 where id = 1;
