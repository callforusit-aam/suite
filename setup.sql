-- Callforus Outbound — preparazione del database (Supabase)
-- Da eseguire UNA volta, su un progetto Supabase nuovo e dedicato a Callforus:
--   Supabase → SQL Editor → New query → incolla tutto → Run.
-- Il file si può rieseguire senza danni (usa "if not exists" e "create or replace").
--
-- Cosa crea:
--   1. ob_users            chi può usare Outbound (elenco di indirizzi email)
--   2. contacts            i contatti della campagna, in tempo reale per tutti
--   3. lead_searches/leads ricerca lead (richiede un flusso n8n vostro, vedi README)
--   4. outbound_events     statistiche anonime di aperture e clic (funzione ob-track)
-- Ogni tabella risponde SOLO a chi ha fatto il login ed è in ob_users.

-- =========================================================================
-- 1. Chi può entrare
-- =========================================================================
create table if not exists public.ob_users (
  email      text primary key check (email = lower(email)),
  nome       text,
  created_at timestamptz not null default now()
);
alter table public.ob_users enable row level security;   -- nessuna policy: si legge solo tramite ob_is_user()

create or replace function public.ob_is_user()
returns boolean
language sql stable security definer set search_path = public as $$
  select exists (
    select 1 from public.ob_users u
    where u.email = lower(coalesce(auth.jwt() ->> 'email', ''))
  );
$$;
revoke all on function public.ob_is_user() from public, anon;
grant execute on function public.ob_is_user() to authenticated;

-- Per aggiungere una persona (dopo averla creata in Authentication → Users):
--   insert into public.ob_users (email, nome) values ('nome@dominio.it', 'Nome');

-- =========================================================================
-- 2. Contatti
-- =========================================================================
create table if not exists public.contacts (
  id                text primary key default gen_random_uuid()::text,
  email             text,
  azienda           text,
  sede              text,
  ruolo             text,
  settore           text,
  descrizione       text,
  sito_web          text,
  tipo_asset        text,
  oggetto           text,          -- oggetto della prima email (facoltativo)
  corpo             text,          -- corpo della prima email (facoltativo)
  scheduled_date    date,          -- vuoto = "da pianificare"
  step              int default 0,
  stato             text,
  anchor_date       date,
  data_ultimo_invio date,
  ha_risposto       boolean default false,
  thread_id         text,
  message_id        text,
  data              jsonb,         -- bozze e cronologia (gestito dall'app)
  updated_at        timestamptz default now()
);
alter table public.contacts enable row level security;
drop policy if exists contacts_team on public.contacts;
create policy contacts_team on public.contacts for all to authenticated
  using (public.ob_is_user()) with check (public.ob_is_user());
grant select, insert, update, delete on public.contacts to authenticated;

do $$
begin
  if not exists (select 1 from pg_publication_tables
                 where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'contacts') then
    alter publication supabase_realtime add table public.contacts;
  end if;
end $$;

-- =========================================================================
-- 3. Ricerca lead
--    Outbound scrive una riga in lead_searches; il trigger chiama un webhook n8n
--    che cerca (es. Google Maps via Apify) e salva i risultati in public.leads.
--    Servono due segreti nel Vault di Supabase (Project Settings → Vault):
--      lead_search_webhook_url  indirizzo del webhook n8n di Callforus
--      lead_search_webhook_key  chiave condivisa, inviata nell'header x-callforus-key
--    Senza il flusso n8n la pagina "Ricerca lead" segnala "Webhook n8n non configurato".
-- =========================================================================
create extension if not exists pg_net with schema extensions;

create table if not exists public.lead_searches (
  id          uuid primary key default gen_random_uuid(),
  created_at  timestamptz not null default now(),
  created_by  text,
  params      jsonb not null,
  status      text not null default 'queued' check (status in ('queued','running','done','error')),
  apify_run_id text,
  found       int,
  inserted    int,
  duplicates  int,
  skipped     int,
  error       text,
  started_at  timestamptz,
  finished_at timestamptz,
  spent_usd   numeric not null default 0,
  zone_done   int not null default 0,
  plan        jsonb,
  runs        jsonb not null default '[]'::jsonb,
  note        text
);
create index if not exists lead_searches_created_idx on public.lead_searches (created_at desc);
alter table public.lead_searches enable row level security;
drop policy if exists lead_searches_select on public.lead_searches;
create policy lead_searches_select on public.lead_searches for select to authenticated using (public.ob_is_user());
drop policy if exists lead_searches_insert on public.lead_searches;
create policy lead_searches_insert on public.lead_searches for insert to authenticated with check (public.ob_is_user());
drop policy if exists lead_searches_delete on public.lead_searches;
create policy lead_searches_delete on public.lead_searches for delete to authenticated
  using (public.ob_is_user() and status in ('done','error'));
grant select, insert, delete on public.lead_searches to authenticated;

create table if not exists public.leads (
  id            text primary key default gen_random_uuid()::text,
  azienda       text,
  email         text,
  sede          text,
  ruolo         text,
  settore       text,
  descrizione   text,
  sito_web      text,
  telefono      text,
  fonte         text,
  email_fonte   text,
  search_id     uuid references public.lead_searches(id) on delete set null,
  importato_il  timestamptz,
  data          jsonb,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz default now()
);
create index if not exists leads_search_idx on public.leads (search_id);
alter table public.leads enable row level security;
drop policy if exists leads_select on public.leads;
create policy leads_select on public.leads for select to authenticated using (public.ob_is_user());
drop policy if exists leads_update on public.leads;
create policy leads_update on public.leads for update to authenticated
  using (public.ob_is_user()) with check (public.ob_is_user());
grant select, update on public.leads to authenticated;
-- Il flusso n8n scrive in leads con la service role key (che ignora queste regole).

-- Controlli sulla richiesta di ricerca: limiti di sicurezza anche lato database.
create or replace function public.lead_searches_before_insert()
returns trigger language plpgsql security definer set search_path = public as $$
declare
  p jsonb := new.params;
  n_cat int; n_prov int; n_altri int; tgt int; bud numeric;
begin
  if jsonb_typeof(p) <> 'object' then raise exception 'Parametri della ricerca non validi'; end if;
  if jsonb_typeof(p->'categorie') <> 'array' then raise exception 'Scegli almeno una categoria'; end if;
  n_cat := jsonb_array_length(p->'categorie');
  n_prov := case when jsonb_typeof(p->'province') = 'array' then jsonb_array_length(p->'province') else 0 end;
  n_altri := case when jsonb_typeof(p->'altri') = 'array' then jsonb_array_length(p->'altri') else 0 end;
  if n_cat < 1 or n_cat > 10 then raise exception 'Scegli da 1 a 10 categorie'; end if;
  if n_prov > 20 then raise exception 'Massimo 20 province per ricerca'; end if;
  if n_altri > 10 then raise exception 'Massimo 10 città o zone scritte a mano'; end if;
  if coalesce(p->>'regione','') = '' and n_altri = 0 then raise exception 'Scegli una regione o almeno una città'; end if;
  tgt := coalesce((p->>'target')::int, 0);
  bud := coalesce((p->>'budget_usd')::numeric, 0);
  if tgt < 5 or tgt > 200 then raise exception 'Lead da trovare: da 5 a 200'; end if;
  if bud < 0.1 or bud > 5 then raise exception 'Tetto di spesa: da 0,10 a 5 dollari'; end if;
  if exists (select 1 from public.lead_searches where status in ('queued','running') and created_at > now() - interval '90 minutes') then
    raise exception 'C''è già una ricerca in corso: aspetta che finisca';
  end if;
  new.id := gen_random_uuid();
  new.created_at := now();
  new.created_by := coalesce(auth.jwt()->>'email', new.created_by);
  new.status := 'queued';
  new.apify_run_id := null; new.found := null; new.inserted := null; new.duplicates := null; new.skipped := null;
  new.error := null; new.started_at := null; new.finished_at := null;
  new.spent_usd := 0; new.zone_done := 0; new.plan := null; new.runs := '[]'::jsonb; new.note := null;
  return new;
end $$;
drop trigger if exists lead_searches_bi on public.lead_searches;
create trigger lead_searches_bi before insert on public.lead_searches
  for each row execute function public.lead_searches_before_insert();

create or replace function public.lead_searches_notify()
returns trigger language plpgsql security definer set search_path = public, extensions as $$
declare
  hook text; k text;
begin
  select decrypted_secret into hook from vault.decrypted_secrets where name = 'lead_search_webhook_url';
  select decrypted_secret into k    from vault.decrypted_secrets where name = 'lead_search_webhook_key';
  if hook is null or k is null then
    update public.lead_searches set status = 'error', error = 'Webhook n8n non configurato', finished_at = now() where id = new.id;
    return new;
  end if;
  perform net.http_post(
    url := hook,
    body := jsonb_build_object('search_id', new.id),
    headers := jsonb_build_object('Content-Type','application/json','x-callforus-key', k),
    timeout_milliseconds := 10000
  );
  return new;
end $$;
drop trigger if exists lead_searches_ai on public.lead_searches;
create trigger lead_searches_ai after insert on public.lead_searches
  for each row execute function public.lead_searches_notify();

revoke all on function public.lead_searches_before_insert() from public, anon, authenticated;
revoke all on function public.lead_searches_notify()        from public, anon, authenticated;

-- =========================================================================
-- 4. Statistiche anonime (aperture e clic)
--    Ogni email ha un codice casuale (nonce) che NON viene salvato con il contatto:
--    si contano le email aperte o cliccate, non le persone.
--    Le registra la funzione edge "ob-track" (supabase/functions/ob-track).
-- =========================================================================
create table if not exists public.outbound_events (
  id         bigint generated always as identity primary key,
  created_at timestamptz not null default now(),
  type       text not null check (type in ('sent','open','click')),
  step       smallint not null check (step between 0 and 20),
  nonce      text not null check (nonce ~ '^[a-z0-9]{8,40}$'),
  url        text,
  bot        boolean not null default false
);
create index if not exists outbound_events_nonce_idx   on public.outbound_events (nonce);
create index if not exists outbound_events_created_idx on public.outbound_events (created_at);
create unique index if not exists outbound_events_sent_uniq on public.outbound_events (nonce) where type = 'sent';
alter table public.outbound_events enable row level security;      -- nessuna policy: ci scrive solo ob-track

-- Domini verso cui i link tracciati possono rimandare (niente redirect verso siti a caso).
create table if not exists public.outbound_link_hosts (host text primary key);
alter table public.outbound_link_hosts enable row level security;
insert into public.outbound_link_hosts (host) values
  ('linkedin.com'),('instagram.com'),('facebook.com'),('calendly.com'),('cal.com'),('wa.me')
on conflict do nothing;
-- Aggiungi il sito di Callforus:
--   insert into public.outbound_link_hosts (host) values ('dominio-callforus.it') on conflict do nothing;

create or replace function public.outbound_track_sent(p_step int, p_nonce text)
returns void language sql security definer set search_path = public as $$
  insert into public.outbound_events (type, step, nonce)
  select 'sent', p_step, lower(p_nonce)
  where public.ob_is_user()
    and p_step between 0 and 20
    and lower(p_nonce) ~ '^[a-z0-9]{8,40}$'
  on conflict do nothing;
$$;

create or replace function public.outbound_stats(p_since timestamptz default null)
returns table(step int, sent bigint, opens_unique bigint, opens_total bigint, clicks_unique bigint, clicks_total bigint, bots bigint)
language sql stable security definer set search_path = public as $$
  with s as (
    select nonce, step from public.outbound_events
    where type = 'sent' and (p_since is null or created_at >= p_since) and public.ob_is_user()
  ),
  e as (select ev.* from public.outbound_events ev join s using (nonce) where ev.type in ('open','click'))
  select s.step::int,
         count(distinct s.nonce),
         (select count(distinct e.nonce) from e where e.step = s.step and not e.bot),
         (select count(*) from e where e.step = s.step and e.type = 'open' and not e.bot),
         (select count(distinct e.nonce) from e where e.step = s.step and e.type = 'click' and not e.bot),
         (select count(*) from e where e.step = s.step and e.type = 'click' and not e.bot),
         (select count(*) from e where e.step = s.step and e.bot)
  from s group by s.step order by s.step;
$$;

create or replace function public.outbound_link_stats(p_since timestamptz default null)
returns table(url text, clicks_total bigint, clicks_unique bigint)
language sql stable security definer set search_path = public as $$
  select ev.url, count(*), count(distinct ev.nonce)
  from public.outbound_events ev
  where public.ob_is_user()
    and ev.type = 'click' and not ev.bot and (p_since is null or ev.created_at >= p_since)
    and exists (select 1 from public.outbound_events s where s.type = 'sent' and s.nonce = ev.nonce)
  group by ev.url order by 2 desc, 1;
$$;

revoke all on function public.outbound_track_sent(int, text)     from public, anon;
revoke all on function public.outbound_stats(timestamptz)        from public, anon;
revoke all on function public.outbound_link_stats(timestamptz)   from public, anon;
grant execute on function public.outbound_track_sent(int, text)   to authenticated;
grant execute on function public.outbound_stats(timestamptz)      to authenticated;
grant execute on function public.outbound_link_stats(timestamptz) to authenticated;
