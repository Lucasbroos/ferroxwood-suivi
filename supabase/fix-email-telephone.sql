-- Remet l'email et le téléphone à leur place quand ils ont été inversés à l'import
-- (à exécuter une fois dans Supabase > SQL Editor > Run)
update public.leads
set email = lower(trim(phone)),
    phone = case
      when regexp_replace(email, '[^0-9]', '', 'g') ~ '^32[0-9]{8,9}$' then '+' || regexp_replace(email, '[^0-9]', '', 'g')
      when regexp_replace(email, '[^0-9]', '', 'g') ~ '^0[0-9]{8,9}$'  then '+32' || substr(regexp_replace(email, '[^0-9]', '', 'g'), 2)
      else nullif(trim(email), '') end,
    updated_at = now()
where coalesce(email, '') not like '%@%' and coalesce(phone, '') like '%@%';

select name, email, phone, source from public.leads where source = 'Site web' order by received_on desc limit 10;
