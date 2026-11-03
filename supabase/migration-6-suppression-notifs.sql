-- =====================================================================
-- Migration 6 · Suppression (demandes, devis) + notifications
-- À exécuter une fois dans Supabase > SQL Editor > New query > Run. Peut être relancé sans risque.
-- =====================================================================

-- Une demande « supprimée » est masquée mais conservée : sinon la synchro du Sheet la réimporterait.
alter table public.leads add column if not exists deleted_at timestamptz;
create index if not exists leads_deleted_idx on public.leads (deleted_at);

-- Suppression d'un devis (ligne + PDF) depuis la plateforme
drop policy if exists quotes_delete on public.quotes;
create policy quotes_delete on public.quotes for delete to authenticated using (public.is_member());
drop policy if exists devis_delete on storage.objects;
create policy devis_delete on storage.objects for delete to authenticated
  using (bucket_id = 'devis' and public.is_member());

-- Email immédiat à chaque nouvelle demande importée (adresses : « Notifications envoyées à »)
alter table public.settings add column if not exists notify_new_leads boolean not null default true;
