-- Fiere → espositori → analisi → Outbound
-- Estende fiere_espositori (creata da prospects.sql) con i dati dell'analisi.
-- Da eseguire una volta nel SQL Editor di Supabase, dopo prospects.sql.

alter table public.fiere_espositori
  add column if not exists sito text,
  add column if not exists paese text,
  add column if not exists categoria text,
  add column if not exists ragione_sociale text,
  add column if not exists email text,
  add column if not exists emails text[] not null default '{}',
  add column if not exists telefono text,
  add column if not exists descrizione text,
  add column if not exists fatturato numeric(14,0),
  add column if not exists fatturato_anno int,
  add column if not exists fatturato_fonte text,
  add column if not exists dipendenti int,
  add column if not exists famosa boolean,
  add column if not exists famosa_motivo text,
  add column if not exists amazon text check (amazon in ('si','no','nd')),
  add column if not exists esito text not null default 'Da analizzare',
  add column if not exists motivo text,
  add column if not exists esito_manuale boolean not null default false,
  add column if not exists analizzato_il timestamptz,
  add column if not exists contact_id text,
  add column if not exists note text,
  add column if not exists data jsonb not null default '{}'::jsonb,
  add column if not exists updated_at timestamptz not null default now();

do $$ begin
  alter table public.fiere_espositori add constraint fiere_espositori_esito_chk
    check (esito in ('Da analizzare','Idoneo','Da verificare','Scartato','In Outbound'));
exception when duplicate_object then null; end $$;

create index if not exists fiere_espositori_fiera_idx on public.fiere_espositori (fiera);
create index if not exists fiere_espositori_esito_idx on public.fiere_espositori (esito);

create or replace function public.fiere_espositori_touch()
returns trigger language plpgsql set search_path = public as $$
begin new.updated_at := now(); return new; end $$;
drop trigger if exists fiere_espositori_bu on public.fiere_espositori;
create trigger fiere_espositori_bu before update on public.fiere_espositori
  for each row execute function public.fiere_espositori_touch();
