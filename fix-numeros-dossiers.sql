-- =====================================================================
-- Renumérote les dossiers FW-001, FW-002… dans l'ordre d'arrivée
-- et remet le compteur au bon endroit. À exécuter UNE fois, après avoir
-- mis en ligne la nouvelle version de api/import.js.
--
-- ⚠️ Les emails déjà envoyés contiennent l'ancien numéro dans l'adresse de
-- réponse : une réponse à ces anciens emails sera quand même rattachée
-- au bon dossier grâce à l'email du client.
-- =====================================================================

with ordered as (
  select id, row_number() over (order by received_on, created_at, id) as n
  from public.leads
)
update public.leads l set number = o.n + 1000000 from ordered o where l.id = o.id;   -- étape 1 : éviter les collisions
update public.leads set number = number - 1000000;                                      -- étape 2 : 1, 2, 3…

select setval('public.lead_number_seq', coalesce((select max(number) from public.leads), 0) + 1, false);

select number, name, received_on from public.leads order by number desc limit 5;
