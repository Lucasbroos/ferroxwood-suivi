-- Migration 5 · « Déjà traité » : permet de sortir un dossier de « À répondre »
-- quand on a répondu au client hors plateforme (téléphone, WhatsApp…). Peut être relancé sans risque.
alter table public.leads add column if not exists handled_at timestamptz;
