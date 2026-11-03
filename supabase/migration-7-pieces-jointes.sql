-- Migration 7 · Pièces jointes dans les emails envoyés depuis la plateforme
-- Autorise l'équipe à déposer des fichiers dans le stockage « pieces » (photos, plans, PDF…).
-- À exécuter une fois dans Supabase > SQL Editor > Run. Peut être relancé sans risque.
drop policy if exists pieces_write on storage.objects;
create policy pieces_write on storage.objects for insert to authenticated
  with check (bucket_id = 'pieces' and public.is_member());
