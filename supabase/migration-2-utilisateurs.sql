-- =====================================================================
-- Migration 2 · Gestion des utilisateurs (rôles admin / commercial)
-- À exécuter une fois dans Supabase > SQL Editor > New query > Run
-- (après schema.sql). Peut être relancé sans risque.
-- =====================================================================

alter table public.members add column if not exists role text not null default 'commercial';
alter table public.members drop constraint if exists members_role_check;
alter table public.members add constraint members_role_check check (role in ('admin', 'commercial'));
alter table public.members add column if not exists added_by text;

create or replace function public.is_admin()
returns boolean
language sql stable security definer
set search_path = public
as $$
  select exists (
    select 1 from public.members
    where email = lower(coalesce(auth.jwt() ->> 'email', '')) and role = 'admin'
  );
$$;

-- Les membres voient la liste de l'équipe (pour le champ « Responsable »).
-- Les ajouts / suppressions passent uniquement par /api/users (réservé aux admins).
drop policy if exists members_read on public.members;
create policy members_read on public.members for select to authenticated using (public.is_member());

-- Seuls les admins peuvent modifier les paramètres (délais, textes des relances).
drop policy if exists settings_update on public.settings;
create policy settings_update on public.settings for update to authenticated
  using (public.is_admin()) with check (public.is_admin());

-- ---------------------------------------------------------------------
-- À ADAPTER : passez votre propre compte en admin
-- ---------------------------------------------------------------------
update public.members set role = 'admin' where email = 'lucas@netcetera.lu';

select email, name, role from public.members order by role, email;
