-- =====================================================================
-- Migration 3 · Échanges emails (envoyés + réponses des clients) et envoi du devis
-- À exécuter une fois dans Supabase > SQL Editor > New query > Run
-- (après schema.sql et migration-2). Peut être relancé sans risque.
-- =====================================================================

create table if not exists public.lead_messages (
  id          bigserial primary key,
  lead_id     uuid not null references public.leads(id) on delete cascade,
  direction   text not null check (direction in ('in', 'out')),   -- in = réponse du client, out = email envoyé
  at          timestamptz not null default now(),
  from_email  text,
  to_email    text,
  subject     text,
  body        text,
  attachments jsonb not null default '[]'::jsonb,                 -- [{ name, path, type, size }]
  resend_id   text unique,                                        -- anti-doublon
  author      text,
  read        boolean not null default true
);
create index if not exists lead_messages_lead_idx on public.lead_messages (lead_id, at desc);
create index if not exists lead_messages_unread_idx on public.lead_messages (read) where read = false;

alter table public.lead_messages enable row level security;
drop policy if exists messages_read on public.lead_messages;
create policy messages_read on public.lead_messages for select to authenticated using (public.is_member());
drop policy if exists messages_mark_read on public.lead_messages;
create policy messages_mark_read on public.lead_messages for update to authenticated
  using (public.is_member()) with check (public.is_member());

-- Pièces jointes reçues des clients (photos, plans…) — bucket privé, tous types de fichiers
insert into storage.buckets (id, name, public, file_size_limit)
values ('pieces', 'pieces', false, 20971520)
on conflict (id) do nothing;

drop policy if exists pieces_read on storage.objects;
create policy pieces_read on storage.objects for select to authenticated
  using (bucket_id = 'pieces' and public.is_member());

-- Modèle de l'email d'envoi du devis
alter table public.settings add column if not exists subject_quote text not null
  default 'Votre devis Ferroxwood – {projet} ({ref})';
alter table public.settings add column if not exists body_quote text not null
  default 'Bonjour {prenom},

Merci pour votre demande. Vous trouverez en pièce jointe notre devis {ref} pour votre projet « {projet} ».

N’hésitez pas à répondre directement à cet email si vous avez des questions ou souhaitez ajuster certains éléments.

Belle journée,
{signature}';
