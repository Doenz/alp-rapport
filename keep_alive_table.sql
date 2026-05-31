-- =====================================================================
-- Keep-Alive-Tabelle für Supabase-Ping
-- Einmalig im SQL-Editor ausführen.
-- Diese Tabelle ist öffentlich lesbar (kein Login nötig), damit der
-- GitHub-Workflow einen echten DB-Lesezugriff erzeugen kann.
-- =====================================================================

create table if not exists public.keep_alive (
  id int primary key default 1,
  check (id = 1)   -- nur ein einziger Eintrag erlaubt
);

-- Eintrag anlegen (falls noch nicht vorhanden)
insert into public.keep_alive (id) values (1)
  on conflict do nothing;

-- RLS aktivieren, aber anonym lesen erlauben
alter table public.keep_alive enable row level security;

drop policy if exists p_keep_alive_read on public.keep_alive;
create policy p_keep_alive_read on public.keep_alive
  for select using (true);   -- öffentlich, kein Login nötig
