-- Prospect Amazon — tabelle per il flusso di acquisizione clienti di Callforus
-- (estrazione brand da Amazon, qualifica, gap, analisi, sequenza di contatto)
-- Da eseguire una volta nel SQL Editor di Supabase, dopo setup.sql (usa ob_is_user()).

create table if not exists public.prospects (
  id uuid primary key default gen_random_uuid(),
  marketplace text not null default 'amazon.it',
  brand text not null check (length(btrim(brand)) between 1 and 200),
  brand_key text generated always as (lower(regexp_replace(btrim(brand), '\s+', ' ', 'g'))) stored,
  keywords text[] not null default '{}',
  url text,
  -- fase 2: metriche lette dai risultati di ricerca
  prodotti int, prezzo_medio numeric(10,2), stelle numeric(3,1), recensioni int,
  con_badge int, acquisti_mese int, stima_min_mese numeric(12,0), qualificato_il timestamptz,
  fascia text check (fascia in ('A','B','Scarto')),          -- null = calcolata dall'app
  fiera text,
  -- fase 3: azienda e gap
  ragione_sociale text, piva text, sede text, sito_web text, settore text,
  fatturato numeric(14,0), dipendenti int,
  gap jsonb not null default '{}'::jsonb,
  -- fase 4: scheda letta dall'estensione e analisi
  scheda jsonb,
  problemi jsonb not null default '[]'::jsonb,
  caso_studio text, apertura text, video_url text,
  -- fase 5: contatto e sequenza
  contatto_nome text, contatto_ruolo text, linkedin_url text, email text, telefono text,
  stato text not null default 'Estratto' check (stato in ('Estratto','Qualificato','Analizzato','Video pronto','In sequenza','In conversazione','Call fissata','Cliente','Perso','Archivio')),
  seq_start date,
  seq_done jsonb not null default '{}'::jsonb,
  prossima_azione date,
  contact_id text,
  note text,
  created_by text default (auth.jwt() ->> 'email'),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create unique index if not exists prospects_mkt_brand_key on public.prospects (marketplace, brand_key);
create index if not exists prospects_stato_idx on public.prospects (stato);
create index if not exists prospects_prossima_idx on public.prospects (prossima_azione);

create or replace function public.prospects_before_update()
returns trigger language plpgsql set search_path = public as $$
begin
  new.updated_at := now();
  if new.qualificato_il is not null and old.qualificato_il is null and new.stato = 'Estratto' then
    new.stato := 'Qualificato';
  end if;
  return new;
end $$;
drop trigger if exists prospects_bu on public.prospects;
create trigger prospects_bu before update on public.prospects
  for each row execute function public.prospects_before_update();

alter table public.prospects enable row level security;
drop policy if exists prospects_team on public.prospects;
create policy prospects_team on public.prospects for all to authenticated
  using (public.ob_is_user()) with check (public.ob_is_user());

-- elenchi espositori delle fiere, per l'incrocio con i brand
create table if not exists public.fiere_espositori (
  id bigint generated always as identity primary key,
  fiera text not null check (length(btrim(fiera)) between 1 and 120),
  nome text not null check (length(btrim(nome)) between 1 and 200),
  nome_key text generated always as (lower(regexp_replace(btrim(nome), '\s+', ' ', 'g'))) stored,
  created_at timestamptz not null default now()
);
create unique index if not exists fiere_espositori_uq on public.fiere_espositori (fiera, nome_key);
alter table public.fiere_espositori enable row level security;
drop policy if exists fiere_team on public.fiere_espositori;
create policy fiere_team on public.fiere_espositori for all to authenticated
  using (public.ob_is_user()) with check (public.ob_is_user());

-- aggiunge brand senza doppioni: unisce le keyword, non tocca il resto
create or replace function public.prospects_add_brands(p_keyword text, p_items jsonb)
returns jsonb language plpgsql security invoker set search_path = public as $$
declare n_new int := 0; n_old int := 0; it jsonb; ins boolean; kw text := nullif(btrim(coalesce(p_keyword,'')), '');
begin
  if not public.ob_is_user() then raise exception 'Accesso non abilitato'; end if;
  if jsonb_typeof(p_items) <> 'array' or jsonb_array_length(p_items) > 1000 then raise exception 'Elenco brand non valido'; end if;
  for it in select value from jsonb_array_elements(p_items) loop
    if coalesce(btrim(it->>'brand'), '') = '' then continue; end if;
    insert into public.prospects as p (brand, url, keywords)
      values (left(btrim(it->>'brand'), 200), nullif(it->>'url',''), case when kw is null then '{}'::text[] else array[left(kw,120)] end)
    on conflict (marketplace, brand_key) do update set
      keywords = array(select distinct k from unnest(p.keywords || excluded.keywords) k),
      url = coalesce(p.url, excluded.url)
    returning (xmax = 0) into ins;
    if ins then n_new := n_new + 1; else n_old := n_old + 1; end if;
  end loop;
  return jsonb_build_object('nuovi', n_new, 'gia_presenti', n_old);
end $$;
revoke all on function public.prospects_add_brands(text, jsonb) from public, anon;
grant execute on function public.prospects_add_brands(text, jsonb) to authenticated;

alter publication supabase_realtime add table public.prospects;
