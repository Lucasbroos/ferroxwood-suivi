-- =====================================================================
-- Ferroxwood · Suivi des demandes — schéma Supabase
-- À exécuter une fois dans Supabase > SQL Editor > New query > Run
-- =====================================================================

create extension if not exists pgcrypto;

-- ---------------------------------------------------------------------
-- Utilisateurs autorisés (Ferroxwood + Upper Agency)
-- Ajoutez une ligne par personne qui doit accéder à la plateforme.
-- ---------------------------------------------------------------------
create table if not exists public.members (
  email      text primary key check (email = lower(email)),
  name       text,
  created_at timestamptz not null default now()
);

create or replace function public.is_member()
returns boolean
language sql stable security definer
set search_path = public
as $$
  select exists (
    select 1 from public.members
    where email = lower(coalesce(auth.jwt() ->> 'email', ''))
  );
$$;

-- ---------------------------------------------------------------------
-- Demandes / dossiers
-- ---------------------------------------------------------------------
create sequence if not exists public.lead_number_seq;

create table if not exists public.leads (
  id                   uuid primary key default gen_random_uuid(),
  number               integer not null default nextval('public.lead_number_seq'),
  external_id          text unique,                 -- id du lead Meta / hash ligne Sheet (anti-doublon)
  created_at           timestamptz not null default now(),
  updated_at           timestamptz not null default now(),
  received_on          date not null default (now() at time zone 'Europe/Brussels')::date,
  source               text not null default 'Ajout manuel'
                       check (source in ('Meta','Site web','Ajout manuel')),
  status               text not null default 'Nouvelle demande'
                       check (status in ('Nouvelle demande','À contacter','Contact tenté, sans réponse',
                         'Échange en cours','Informations ou visite à prévoir','Devis à préparer',
                         'Devis envoyé','Devis accepté','Devis refusé','Dossier clôturé')),
  name                 text not null,
  email                text,
  phone                text,
  city                 text,
  project              text not null,
  type                 text not null default 'Autre',
  message              text,
  owner                text default 'Ferroxwood',
  budget               numeric,
  amount               numeric,                     -- montant du devis
  quote_ref            text,                        -- référence du devis
  sent_on              date,                        -- date d'envoi du devis (déclenche les relances)
  next_on              date,                        -- date de la prochaine action
  next_action          text,
  notes                text,
  suspended            boolean not null default false,
  reminders            integer not null default 0,  -- nb de relances envoyées
  last_reminder_on     date,
  reminder_override_on date,                        -- relance reportée manuellement
  draft                text,
  pdf_path             text,
  pdf_name             text,
  raw                  jsonb                        -- ligne brute importée du Sheet
);

create index if not exists leads_status_idx on public.leads (status);
create index if not exists leads_received_idx on public.leads (received_on desc);

-- ---------------------------------------------------------------------
-- Historique de chaque dossier
-- ---------------------------------------------------------------------
create table if not exists public.lead_events (
  id      bigserial primary key,
  lead_id uuid not null references public.leads(id) on delete cascade,
  at      timestamptz not null default now(),
  text    text not null,
  author  text
);
create index if not exists lead_events_lead_idx on public.lead_events (lead_id, at desc);

-- ---------------------------------------------------------------------
-- Paramètres (une seule ligne)
-- ---------------------------------------------------------------------
create table if not exists public.settings (
  id            integer primary key default 1 check (id = 1),
  first_delay   integer not null default 7,   -- 1re relance : X jours après l'envoi du devis
  second_delay  integer not null default 7,   -- 2e relance : X jours après la 1re
  auto_send     boolean not null default false, -- false = relances à valider en 1 clic
  attach_pdf    boolean not null default true,
  notify_email  text,                          -- récap quotidien (plusieurs adresses séparées par des virgules)
  signature     text not null default 'L’équipe Ferroxwood',
  subject_1     text not null default 'Votre projet {projet} – suivi de notre devis {ref}',
  body_1        text not null default 'Bonjour {prenom},

Je reviens vers vous concernant le devis {ref} envoyé le {date_envoi} pour votre projet « {projet} ».

Avez-vous pu en prendre connaissance ? Je reste disponible si vous avez des questions ou souhaitez échanger sur certains éléments.

Si votre projet n’est plus d’actualité, répondez simplement à cet email et nous ne vous relancerons plus.

Belle journée,
{signature}',
  subject_2     text not null default 'Votre projet {projet} – avez-vous eu le temps d’y réfléchir ?',
  body_2        text not null default 'Bonjour {prenom},

Je me permets une dernière relance au sujet de notre devis {ref} pour « {projet} ».

Si vous souhaitez ajuster certains points (dimensions, finitions, budget), nous pouvons en discuter par téléphone ou lors d’une visite.

Si votre projet n’est plus d’actualité, répondez simplement à cet email.

Belle journée,
{signature}',
  last_cron_at  timestamptz
);
insert into public.settings (id) values (1) on conflict (id) do nothing;

-- ---------------------------------------------------------------------
-- Sécurité (RLS) : seuls les membres voient et modifient les données.
-- Les routes /api utilisent la clé service_role et passent outre.
-- ---------------------------------------------------------------------
alter table public.members     enable row level security;
alter table public.leads       enable row level security;
alter table public.lead_events enable row level security;
alter table public.settings    enable row level security;

drop policy if exists members_read on public.members;
create policy members_read on public.members for select to authenticated using (public.is_member());

drop policy if exists leads_all on public.leads;
create policy leads_all on public.leads for all to authenticated
  using (public.is_member()) with check (public.is_member());

drop policy if exists events_read on public.lead_events;
create policy events_read on public.lead_events for select to authenticated using (public.is_member());
drop policy if exists events_insert on public.lead_events;
create policy events_insert on public.lead_events for insert to authenticated with check (public.is_member());

drop policy if exists settings_read on public.settings;
create policy settings_read on public.settings for select to authenticated using (public.is_member());
drop policy if exists settings_update on public.settings;
create policy settings_update on public.settings for update to authenticated
  using (public.is_member()) with check (public.is_member());

-- ---------------------------------------------------------------------
-- Stockage des devis PDF (bucket privé « devis »)
-- ---------------------------------------------------------------------
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('devis', 'devis', false, 10485760, array['application/pdf'])
on conflict (id) do nothing;

drop policy if exists devis_read on storage.objects;
create policy devis_read on storage.objects for select to authenticated
  using (bucket_id = 'devis' and public.is_member());
drop policy if exists devis_write on storage.objects;
create policy devis_write on storage.objects for insert to authenticated
  with check (bucket_id = 'devis' and public.is_member());

-- ---------------------------------------------------------------------
-- À ADAPTER : les personnes autorisées
-- ---------------------------------------------------------------------
-- insert into public.members (email, name) values
--   ('contact@ferroxwood.be', 'Ferroxwood'),
--   ('lucas@upper-agency.be', 'Lucas – Upper Agency');
