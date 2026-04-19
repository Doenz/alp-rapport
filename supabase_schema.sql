-- =======================================================================
-- ALPAPP – Datenbankschema für Supabase
-- =======================================================================
-- Führe dieses Script im Supabase-Studio unter "SQL Editor" aus.
-- Es erstellt alle Tabellen, Rollen und Sicherheitsregeln (RLS).
-- =======================================================================

-- 1) Profile (ergänzt auth.users um Name und Rolle) --------------------
create table if not exists public.profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  name text not null,
  rolle text not null,
  is_admin bool not null default false,           -- System-Administrator-Flag
  erstellt_am timestamptz default now()
);

-- Rollen-Check: idempotent neu setzen (damit neue Rolle 'bestoesser' dazukommt)
alter table public.profiles drop constraint if exists profiles_rolle_check;
alter table public.profiles add constraint profiles_rolle_check check (rolle in (
  'alpmeister_portein',
  'alpmeister_sarn',
  'geschaeftsfuehrer',
  'bestoesser'
));

-- is_admin-Spalte auch nachträglich anlegen, falls Tabelle schon existierte
alter table public.profiles add column if not exists is_admin bool not null default false;

-- Helper-Funktion: aktueller User ist Administrator? (muss vor allen Policies stehen)
create or replace function public.is_admin()
returns bool language sql stable as $$
  select coalesce((select is_admin from public.profiles where id = auth.uid()), false);
$$;

-- 2) Bestösser (Personen, die Stunden leisten) ------------------------
create table if not exists public.bestoesser (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  nst numeric(6,2) not null default 0,           -- Normalstösse
  alpname text not null,
  jahr int not null default extract(year from now()),
  aktiv bool not null default true,
  user_id uuid references auth.users(id) on delete set null,   -- optional: Self-Service-Account
  erstellt_am timestamptz default now(),
  unique (name, jahr)
);

-- Alp-Check: nur 2 Alpen (Portein, Sarn). Alte Werte 'Sarn/Portein' auf 'Portein' migrieren.
update public.bestoesser set alpname = 'Portein' where alpname = 'Sarn/Portein';
alter table public.bestoesser drop constraint if exists bestoesser_alpname_check;
alter table public.bestoesser add constraint bestoesser_alpname_check check (alpname in ('Portein', 'Sarn'));

-- Migration: user_id nachträglich anlegen, falls Tabelle schon existiert
alter table public.bestoesser add column if not exists user_id uuid references auth.users(id) on delete set null;
-- Pro User max. 1 Bestösser pro Jahr
drop index if exists idx_bestoesser_user_jahr;
create unique index idx_bestoesser_user_jahr on public.bestoesser (user_id, jahr) where user_id is not null;

-- 3) Stammdaten: Arbeitsarten ------------------------------------------
create table if not exists public.arbeitsarten (
  id uuid primary key default gen_random_uuid(),
  name text unique not null,
  aktiv bool not null default true
);

-- 4) Stammdaten: Maschinen + Ansätze -----------------------------------
create table if not exists public.maschinen (
  id uuid primary key default gen_random_uuid(),
  name text unique not null,
  kategorie text,
  ansatz numeric(10,2) not null,                 -- Ansatz (CHF)
  einheit text not null default 'Std.',          -- Std., km, m³, Fuder
  quelle text,                                   -- z.B. "Kostenkatalog 2025 Nr. 1005"
  aktiv bool not null default true
);

-- 5) Rapport-Einträge (die eigentlichen Stunden) -----------------------
create table if not exists public.eintraege (
  id uuid primary key default gen_random_uuid(),
  bestoesser_id uuid not null references public.bestoesser(id) on delete cascade,
  datum date not null,
  alpname text not null,
  arbeit text not null,                          -- freier Text ODER Eintrag aus arbeitsarten
  mann_std numeric(6,2) default 0,               -- Mann-Stunden
  maschine_id uuid references public.maschinen(id),
  masch_std numeric(6,2) default 0,              -- Maschinenstunden / Einheiten
  ansatz numeric(10,2) default 0,                -- effektiver Ansatz (kopiert aus maschinen)
  betrag numeric(10,2) generated always as (masch_std * ansatz) stored,
  bemerkung text,
  jahr int generated always as (extract(year from datum)::int) stored,
  erstellt_von uuid references auth.users(id),
  erstellt_am timestamptz default now()
);

create index if not exists idx_eintraege_jahr on public.eintraege (jahr);
create index if not exists idx_eintraege_bestoesser on public.eintraege (bestoesser_id);
create index if not exists idx_eintraege_alpname on public.eintraege (alpname);

-- Alp-Check idempotent: alte Werte migrieren, dann auf 2 Alpen einschränken
update public.eintraege set alpname = 'Portein' where alpname = 'Sarn/Portein';
alter table public.eintraege drop constraint if exists eintraege_alpname_check;
alter table public.eintraege add constraint eintraege_alpname_check check (alpname in ('Portein', 'Sarn'));

-- =======================================================================
-- Hilfsfunktionen
-- =======================================================================
create or replace function public.current_rolle()
returns text language sql stable as $$
  select rolle from public.profiles where id = auth.uid();
$$;

-- ID des Bestösser-Datensatzes des angemeldeten Users (oder NULL)
create or replace function public.current_bestoesser_id()
returns uuid language sql stable as $$
  select id from public.bestoesser
   where user_id = auth.uid()
     and jahr = extract(year from now())::int
   limit 1;
$$;

-- =======================================================================
-- RLS aktivieren und Policies setzen
-- Regel: Alle 3 Rollen haben Lese-Einsicht in alles.
--        Schreibrechte auf Stammdaten hat nur der Geschäftsführer.
--        Alpmeister können Einträge für ihre Alp verwalten.
-- =======================================================================
alter table public.profiles    enable row level security;
alter table public.bestoesser  enable row level security;
alter table public.arbeitsarten enable row level security;
alter table public.maschinen   enable row level security;
alter table public.eintraege   enable row level security;

-- profiles: jeder angemeldete User darf lesen, nur selber bearbeiten
drop policy if exists p_profiles_read on public.profiles;
create policy p_profiles_read on public.profiles
  for select using (auth.uid() is not null);

drop policy if exists p_profiles_insert_self on public.profiles;
create policy p_profiles_insert_self on public.profiles
  for insert with check (id = auth.uid());

drop policy if exists p_profiles_update_self on public.profiles;
create policy p_profiles_update_self on public.profiles
  for update using (id = auth.uid());

-- bestoesser: lesen alle angemeldeten (für Dropdowns, Link-Schritt),
--             schreiben Alpmeister ihrer Alp + GF,
--             Bestösser darf den eigenen Datensatz mit user_id = auth.uid() verknüpfen
drop policy if exists p_bestoesser_read on public.bestoesser;
create policy p_bestoesser_read on public.bestoesser
  for select using (public.current_rolle() is not null);

-- Alpmeister, GF und Admin dürfen ALLE Bestösser-Datensätze verwalten (beide Alpen).
drop policy if exists p_bestoesser_write on public.bestoesser;
create policy p_bestoesser_write on public.bestoesser
  for all using (
    public.current_rolle() in ('geschaeftsfuehrer','alpmeister_portein','alpmeister_sarn')
  ) with check (
    public.current_rolle() in ('geschaeftsfuehrer','alpmeister_portein','alpmeister_sarn')
  );

-- Jeder angemeldete User darf den eigenen Bestösser-Datensatz claimen
-- (user_id auf sich setzen), sofern noch nicht anderweitig verknüpft.
drop policy if exists p_bestoesser_claim on public.bestoesser;
create policy p_bestoesser_claim on public.bestoesser
  for update using (
    auth.uid() is not null
    and (user_id is null or user_id = auth.uid())
  ) with check (user_id = auth.uid());

-- arbeitsarten: lesen alle, schreiben Alpmeister + GF
drop policy if exists p_arbeitsarten_read on public.arbeitsarten;
create policy p_arbeitsarten_read on public.arbeitsarten
  for select using (public.current_rolle() is not null);

drop policy if exists p_arbeitsarten_write on public.arbeitsarten;
create policy p_arbeitsarten_write on public.arbeitsarten
  for all using (public.current_rolle() in (
    'geschaeftsfuehrer','alpmeister_portein','alpmeister_sarn'
  )) with check (public.current_rolle() in (
    'geschaeftsfuehrer','alpmeister_portein','alpmeister_sarn'
  ));

-- maschinen: lesen alle, schreiben Alpmeister + GF
drop policy if exists p_maschinen_read on public.maschinen;
create policy p_maschinen_read on public.maschinen
  for select using (public.current_rolle() is not null);

drop policy if exists p_maschinen_write on public.maschinen;
create policy p_maschinen_write on public.maschinen
  for all using (public.current_rolle() in (
    'geschaeftsfuehrer','alpmeister_portein','alpmeister_sarn'
  )) with check (public.current_rolle() in (
    'geschaeftsfuehrer','alpmeister_portein','alpmeister_sarn'
  ));

-- eintraege:
--   Lesen:   die 3 Rollen sehen alles; Bestösser sieht nur eigene.
--   Schreiben: Alpmeister → ihre Alp; GF → alles; Bestösser → nur eigene Einträge.
drop policy if exists p_eintraege_read on public.eintraege;
create policy p_eintraege_read on public.eintraege
  for select using (
    public.current_rolle() in ('geschaeftsfuehrer','alpmeister_portein','alpmeister_sarn')
    or (public.current_rolle() = 'bestoesser' and bestoesser_id = public.current_bestoesser_id())
  );

drop policy if exists p_eintraege_write on public.eintraege;
create policy p_eintraege_write on public.eintraege
  for all using (
    public.current_rolle() = 'geschaeftsfuehrer'
    or (public.current_rolle() = 'alpmeister_portein' and alpname = 'Portein')
    or (public.current_rolle() = 'alpmeister_sarn'    and alpname = 'Sarn')
    or (public.current_rolle() = 'bestoesser' and bestoesser_id = public.current_bestoesser_id())
  ) with check (
    public.current_rolle() = 'geschaeftsfuehrer'
    or (public.current_rolle() = 'alpmeister_portein' and alpname = 'Portein')
    or (public.current_rolle() = 'alpmeister_sarn'    and alpname = 'Sarn')
    or (public.current_rolle() = 'bestoesser' and bestoesser_id = public.current_bestoesser_id())
  );

-- =======================================================================
-- Grunddaten befüllen
-- Ansätze stammen aus Agroscope Kostenkatalog 2025 (Richtwerte) bzw.
-- bisherigen Erfahrungswerten. Der Geschäftsführer kann sie anpassen.
-- =======================================================================

insert into public.arbeitsarten (name) values
  ('Wasser'),
  ('Wasser und Zaun'),
  ('Zäune'),
  ('Zäune freischneiden'),
  ('Ziegenzaun'),
  ('Material beschaffung'),
  ('Matten waschen'),
  ('Matten holen in Mon'),
  ('Strassenrigolen reinigen'),
  ('Fliegenbehandlung'),
  ('Tränke ersetzen See'),
  ('Tränke See abbau'),
  ('Vieh scheiden'),
  ('Abfall laden'),
  ('Hütte einwintern'),
  ('Mist'),
  ('Gräben öffnen'),
  ('Wasser entlüften'),
  ('Frostschutz'),
  ('Abwassertank leeren'),
  ('Familientag'),
  ('Alpmeistertagung'),
  ('Wasser, Einfang'),
  ('Bestossung'),
  ('Übriges')
on conflict (name) do nothing;

-- Alp-relevante Maschinen aus Agroscope Kostenkatalog 2025
-- Ansätze = niedriger Richtwert (CHF pro Einheit). Der Geschäftsführer
-- kann im Stammdaten-Tab Ansätze anpassen.
insert into public.maschinen (name, kategorie, ansatz, einheit, quelle) values
  -- Fahrzeug (Pauschale) --------------------------------------------------
  ('Auto (privat)',                                       'Fahrzeug',          0.70, 'km',    'Pauschal-Ansatz Privatfahrt'),

  -- Traktoren Standard (Nr. 1001–1014) ------------------------------------
  ('Traktor 30–36 kW (41–49 PS)',                         'Traktor',          24.00, 'Std.',  'Kostenkatalog 2025 Nr. 1001'),
  ('Traktor 37–44 kW (50–60 PS)',                         'Traktor',          30.00, 'Std.',  'Kostenkatalog 2025 Nr. 1002'),
  ('Traktor 45–54 kW (61–73 PS)',                         'Traktor',          31.00, 'Std.',  'Kostenkatalog 2025 Nr. 1003'),
  ('Traktor 55–64 kW (74–87 PS)',                         'Traktor',          36.00, 'Std.',  'Kostenkatalog 2025 Nr. 1004'),
  ('Traktor 65–74 kW (88–101 PS)',                        'Traktor',          39.00, 'Std.',  'Kostenkatalog 2025 Nr. 1005'),
  ('Traktor 75–89 kW (102–121 PS)',                       'Traktor',          44.00, 'Std.',  'Kostenkatalog 2025 Nr. 1006'),
  ('Traktor 90–104 kW (122–142 PS)',                      'Traktor',          56.00, 'Std.',  'Kostenkatalog 2025 Nr. 1010'),
  ('Traktor 105–124 kW (143–169 PS)',                     'Traktor',          63.00, 'Std.',  'Kostenkatalog 2025 Nr. 1011'),
  ('Traktor 125–149 kW (171–203 PS)',                     'Traktor',          76.00, 'Std.',  'Kostenkatalog 2025 Nr. 1012'),
  ('Doppelbereifung Traktor bis 64 kW',                   'Traktor',           2.40, 'Std.',  'Kostenkatalog 2025 Nr. 1021'),
  ('Doppelbereifung Traktor ab 65 kW',                    'Traktor',           3.60, 'Std.',  'Kostenkatalog 2025 Nr. 1024'),
  ('Traktor mit Forstausrüstung (90 kW)',                 'Traktor',          91.00, 'Std.',  'Kostenkatalog 2025 Nr. 1030'),

  -- Spezial-Traktoren -----------------------------------------------------
  ('Schmalspurtraktor (Obstbau), 30 kW',                  'Spezialtraktor',   30.00, 'Std.',  'Kostenkatalog 2025 Nr. 1040'),
  ('Schmalspurtraktor 37 kW (50 PS)',                     'Spezialtraktor',   44.00, 'Std.',  'Kostenkatalog 2025 Nr. 1043'),
  ('Schmalspurtraktor 45 kW (61 PS)',                     'Spezialtraktor',   53.00, 'Std.',  'Kostenkatalog 2025 Nr. 1044'),
  ('Traktor mit Knicklenkung, 40 kW',                     'Spezialtraktor',   56.00, 'Std.',  'Kostenkatalog 2025 Nr. 1051'),
  ('Traktor mit Knicklenkung, 50 kW',                     'Spezialtraktor',   18.00, 'Std.',  'Kostenkatalog 2025 Nr. 1052'),
  ('Raupentransporter mit Brücke (Benzin)',               'Spezialtraktor',   24.00, 'Std.',  'Kostenkatalog 2025 Nr. 1058'),

  -- Zweiachsmäher (Hanggeräteträger, Nr. 1071–1075) -----------------------
  ('Zweiachsmäher 30 kW (41 PS)',                         'Zweiachsmäher',    44.00, 'Std.',  'Kostenkatalog 2025 Nr. 1071'),
  ('Zweiachsmäher 35 kW (48 PS)',                         'Zweiachsmäher',    46.00, 'Std.',  'Kostenkatalog 2025 Nr. 1072'),
  ('Zweiachsmäher 45 kW (61 PS)',                         'Zweiachsmäher',    47.00, 'Std.',  'Kostenkatalog 2025 Nr. 1073'),
  ('Zweiachsmäher 55 kW (75 PS)',                         'Zweiachsmäher',    55.00, 'Std.',  'Kostenkatalog 2025 Nr. 1074'),
  ('Zweiachsmäher 70 kW (95 PS)',                         'Zweiachsmäher',    60.00, 'Std.',  'Kostenkatalog 2025 Nr. 1075'),

  -- Hoflader / Umschlag ---------------------------------------------------
  ('Hof-/Kompaktlader Diesel, 20 kW',                     'Hoflader',         31.00, 'Std.',  'Kostenkatalog 2025 Nr. 1101'),
  ('Hoflader elektrisch, 10–15 kW',                       'Hoflader',         29.00, 'Std.',  'Kostenkatalog 2025 Nr. 1111'),

  -- Motormäher / Einachser ------------------------------------------------
  ('Motormäher, 1.6 m Balken (Benzin, 6.6 kW)',           'Motormäher',       33.00, 'Std.',  'Kostenkatalog 2025 Nr. 1121'),
  ('Motormäher, 1.9 m Balken (Benzin, 10 kW)',            'Motormäher',       57.00, 'Std.',  'Kostenkatalog 2025 Nr. 1123'),

  -- Motor-Kleingeräte, Forstgeräte ----------------------------------------
  ('Kettensäge 0.4 m Schwert (Benzin, 2 kW)',             'Motorsäge',        12.00, 'Std.',  'Kostenkatalog 2025 Nr. 1141'),
  ('Kettensäge 0.5 m Schwert (Benzin, 4 kW)',             'Motorsäge',        20.00, 'Std.',  'Kostenkatalog 2025 Nr. 1142'),
  ('Kettensäge 0.6 m Schwert (Benzin, 5 kW)',             'Motorsäge',        16.00, 'Std.',  'Kostenkatalog 2025 Nr. 1143'),
  ('Rindenschälgerät mit Motorsäge (4 kW)',               'Motorsäge',        21.50, 'Std.',  'Kostenkatalog 2025 Nr. 1144'),
  ('Motorsense/Trimmer (Benzin, 2 kW)',                   'Motorsäge',        12.50, 'Std.',  'Kostenkatalog 2025 Nr. 1145'),
  ('Forstfreischneider (Benzin, 3 kW)',                   'Motorsäge',        15.00, 'Std.',  'Kostenkatalog 2025 Nr. 1146'),
  ('Rückensprühgerät, 25 l (Benzin, 0.7 kW)',             'Motorsäge',        16.50, 'Std.',  'Kostenkatalog 2025 Nr. 1147'),
  ('Blasgerät/Rucksackbläser (3 kW)',                     'Motorsäge',        14.50, 'Std.',  'Kostenkatalog 2025 Nr. 1148'),
  ('Pflanzlochbohrer (Benzin, 4 kW)',                     'Motorsäge',        16.00, 'Std.',  'Kostenkatalog 2025 Nr. 1149'),

  -- Geländefahrzeuge / Viehtransporter ------------------------------------
  ('Gelände-Allzweckfahrzeug (ATV) Benzin, 10 kW',        'Geländefahrzeug',  22.00, 'Std.',  'Kostenkatalog 2025 Nr. 1161'),
  ('Gelände-Allzweckfahrzeug (ATV) Diesel, 15 kW',        'Geländefahrzeug',  28.00, 'Std.',  'Kostenkatalog 2025 Nr. 1162'),
  ('Geländewagen/Pick-up Diesel, 125 kW',                 'Geländefahrzeug',   0.70, 'km',    'Kostenkatalog 2025 Nr. 1163'),
  ('Geländewagen Diesel, 140 kW',                         'Geländefahrzeug',   0.80, 'km',    'Kostenkatalog 2025 Nr. 1164'),
  ('Viehtransporter 3.5 t Diesel, 84 kW',                 'Geländefahrzeug',   1.10, 'km',    'Kostenkatalog 2025 Nr. 1165'),

  -- Frontlader und Anbaugeräte --------------------------------------------
  ('Frontlader leicht, ohne Anbau',                       'Frontlader',       10.50, 'Std.',  'Kostenkatalog 2025 Nr. 2011'),
  ('Frontlader schwer, > 66 kW',                          'Frontlader',        2.60, 'Std.',  'Kostenkatalog 2025 Nr. 2014'),
  ('Mistgabel zu Frontlader, 1.7–2 m',                    'Frontlader',        7.10, 'Std.',  'Kostenkatalog 2025 Nr. 2017'),
  ('Transportgabel Grossballen zu Frontlader',            'Frontlader',        3.10, 'Std.',  'Kostenkatalog 2025 Nr. 2018'),
  ('Erdschaufel zu Frontlader, 1.9–2.5 m',                'Frontlader',        3.00, 'Std.',  'Kostenkatalog 2025 Nr. 2019'),
  ('Silozange zu Frontlader, 1.2–1.8 m',                  'Frontlader',        6.30, 'Std.',  'Kostenkatalog 2025 Nr. 2020'),
  ('Krokodilzange zu Frontlader, 1.2–2.2 m',              'Frontlader',        4.30, 'Std.',  'Kostenkatalog 2025 Nr. 2021'),

  -- Dreipunkt-Zusatzgeräte ------------------------------------------------
  ('Transportgabel Grossballen (Dreipunkt)',              'Dreipunkt',         2.40, 'Std.',  'Kostenkatalog 2025 Nr. 2031'),
  ('Grossballengreifer, 1.5–2 m',                         'Dreipunkt',        10.10, 'Std.',  'Kostenkatalog 2025 Nr. 2032'),
  ('Entnahme-/Verteilgerät Flachsilo',                    'Dreipunkt',         8.50, 'Std.',  'Kostenkatalog 2025 Nr. 2033'),
  ('Hecklader mit Mistgabel',                             'Dreipunkt',         3.40, 'Std.',  'Kostenkatalog 2025 Nr. 2036'),
  ('Hecklader hydraulisch',                               'Dreipunkt',        10.70, 'Std.',  'Kostenkatalog 2025 Nr. 2037'),
  ('Hubstapler Heckanbau, 3 m Hubhöhe',                   'Dreipunkt',         9.20, 'Std.',  'Kostenkatalog 2025 Nr. 2039'),

  -- Zusatzgeräte zu Transporter -------------------------------------------
  ('Kippbrücke Metall zu Transporter',                    'Transporter',      14.00, 'Std.',  'Kostenkatalog 2025 Nr. 2052'),
  ('Aufbaukran zu Kippbrücke',                            'Transporter',      17.50, 'Std.',  'Kostenkatalog 2025 Nr. 2053'),

  -- Schneeräumung ---------------------------------------------------------
  ('Schneepflug zu Traktor, bis 59 kW',                   'Schneeräumung',    22.00, 'Std.',  'Kostenkatalog 2025 Nr. 2071'),
  ('Schneepflug zu Traktor, 60–88 kW',                    'Schneeräumung',    33.00, 'Std.',  'Kostenkatalog 2025 Nr. 2072'),
  ('Schneepflug zu Traktor, ab 89 kW',                    'Schneeräumung',    29.00, 'Std.',  'Kostenkatalog 2025 Nr. 2073'),
  ('Schneeschleuder zu Traktor',                          'Schneeräumung',    43.00, 'Std.',  'Kostenkatalog 2025 Nr. 2074'),
  ('Schneeschleuder zu Traktor, ab 80 kW',                'Schneeräumung',    38.00, 'Std.',  'Kostenkatalog 2025 Nr. 2076'),
  ('Salzstreuer bis 600 l',                               'Schneeräumung',    20.00, 'Std.',  'Kostenkatalog 2025 Nr. 2077'),
  ('Schneeketten zu Traktor vorne (Paar)',                'Schneeräumung',    10.00, 'Std.',  'Kostenkatalog 2025 Nr. 2079'),

  -- Mähwerke zu Zweiachsmäher / kleine Traktoren --------------------------
  ('Mähwerk, 1.9 m',                                      'Mähwerk',          38.00, 'ha',    'Kostenkatalog 2025 Nr. 2101'),

  -- Transport / Einachs-Anhänger ------------------------------------------
  ('Einachs-Kippanhänger, 3–4 t',                         'Anhänger',          9.00, 'Std.',  'Kostenkatalog 2025 Nr. 3041'),
  ('Einachs-Kippanhänger, 5–6 t',                         'Anhänger',         11.00, 'Std.',  'Kostenkatalog 2025 Nr. 3042'),
  ('Einachs-Kippanhänger, 7–8 t',                         'Anhänger',         13.00, 'Std.',  'Kostenkatalog 2025 Nr. 3043'),
  ('Dreiseiten-Kipper Einachs, 5 t',                      'Anhänger',         12.00, 'Std.',  'Kostenkatalog 2025 Nr. 3045'),

  -- Zweiachs-Anhänger -----------------------------------------------------
  ('Zweiachs-Kippanhänger, 8–10 t',                       'Anhänger',         14.00, 'Std.',  'Kostenkatalog 2025 Nr. 4001'),
  ('Zweiachs-Kippanhänger, 12–14 t',                      'Anhänger',         18.00, 'Std.',  'Kostenkatalog 2025 Nr. 4005'),
  ('Tandem-Dreiseitenkipper, 16 t',                       'Anhänger',         22.00, 'Std.',  'Kostenkatalog 2025 Nr. 4007'),
  ('Plattformwagen, 5 t',                                 'Anhänger',          6.50, 'Std.',  'Kostenkatalog 2025 Nr. 4022'),
  ('Plattformwagen, 8 t',                                 'Anhänger',          9.00, 'Std.',  'Kostenkatalog 2025 Nr. 4025'),
  ('Lenk-Triebachsanhänger an Traktor',                   'Anhänger',         11.50, 'Std.',  'Kostenkatalog 2025 Nr. 4072'),

  -- Düngerstreuer (Mineraldünger) -----------------------------------------
  ('Einkasten-Düngerstreuer, 2.5 m',                      'Düngerstreuer',    17.00, 'ha',    'Kostenkatalog 2025 Nr. 6001'),
  ('Schleuderstreuer bis 500 l',                          'Düngerstreuer',    37.00, 'ha',    'Kostenkatalog 2025 Nr. 6003'),
  ('Schleuderstreuer ab 1000 l',                          'Düngerstreuer',     9.00, 'ha',    'Kostenkatalog 2025 Nr. 6005'),

  -- Miststreuer -----------------------------------------------------------
  ('Aufbau-Seitenstreuer Transp., 2.5 m³',                'Miststreuer',      27.00, 'Fuder', 'Kostenkatalog 2025 Nr. 6021'),
  ('Aufbau-Seitenstreuer Transp., 4.5 m³',                'Miststreuer',      34.00, 'Fuder', 'Kostenkatalog 2025 Nr. 6023'),
  ('Miststreuer Seitenstreuwerk, 7 m³',                   'Miststreuer',      33.00, 'Fuder', 'Kostenkatalog 2025 Nr. 6025'),
  ('Miststreuer, 10 m³',                                  'Miststreuer',      35.00, 'Fuder', 'Kostenkatalog 2025 Nr. 6027'),
  ('Universalstreuer, 14 m³',                             'Miststreuer',      36.00, 'Fuder', 'Kostenkatalog 2025 Nr. 6029'),
  ('Universalstreuer, 21 m³',                             'Miststreuer',      28.00, 'Fuder', 'Kostenkatalog 2025 Nr. 6031'),

  -- Mistkräne / Hydrauliklader --------------------------------------------
  ('Mistkran Hydrauliklader Dreipunkt',                   'Mistkran',          1.90, 'm³',    'Kostenkatalog 2025 Nr. 6041'),

  -- Vakuumfässer (Nr. 6051–6058) ------------------------------------------
  ('Aufbau-Vakuumfass zu Transp., 3000 l',                'Güllefass',         2.60, 'm³',    'Kostenkatalog 2025 Nr. 6051'),
  ('Vakuumfass, 4000 l',                                  'Güllefass',         1.90, 'm³',    'Kostenkatalog 2025 Nr. 6053'),
  ('Vakuumfass, 5000 l',                                  'Güllefass',         1.70, 'm³',    'Kostenkatalog 2025 Nr. 6054'),
  ('Vakuumfass, 6000 l',                                  'Güllefass',         1.50, 'm³',    'Kostenkatalog 2025 Nr. 6055'),
  ('Vakuumfass, 8000 l',                                  'Güllefass',         1.50, 'm³',    'Kostenkatalog 2025 Nr. 6056'),
  ('Vakuumfass, 10 000 l',                                'Güllefass',         1.30, 'm³',    'Kostenkatalog 2025 Nr. 6057'),
  ('Vakuumfass, 12 000 l',                                'Güllefass',         1.20, 'm³',    'Kostenkatalog 2025 Nr. 6058'),

  -- Pumpfässer (Nr. 6069–6079) --------------------------------------------
  ('Aufbau-Pumpfass zu Transp., 2600 l',                  'Güllefass',         3.60, 'm³',    'Kostenkatalog 2025 Nr. 6069'),
  ('Aufbau-Pumpfass zu Transp., 3000 l',                  'Güllefass',         2.80, 'm³',    'Kostenkatalog 2025 Nr. 6071'),
  ('Aufbau-Pumpfass zu Transp., 3500 l',                  'Güllefass',         2.50, 'm³',    'Kostenkatalog 2025 Nr. 6072'),
  ('Pumpfass, 4000 l',                                    'Güllefass',         2.50, 'm³',    'Kostenkatalog 2025 Nr. 6073'),
  ('Pumpfass, 5000 l',                                    'Güllefass',         2.00, 'm³',    'Kostenkatalog 2025 Nr. 6074'),
  ('Pumpfass, 6000 l',                                    'Güllefass',         2.00, 'm³',    'Kostenkatalog 2025 Nr. 6075'),
  ('Pumpfass, 8000 l',                                    'Güllefass',         1.80, 'm³',    'Kostenkatalog 2025 Nr. 6076'),
  ('Pumpfass, 10 000 l',                                  'Güllefass',         1.70, 'm³',    'Kostenkatalog 2025 Nr. 6077'),
  ('Pumpfass, 12 000 l',                                  'Güllefass',         1.70, 'm³',    'Kostenkatalog 2025 Nr. 6078'),
  ('Pumpfass, 15 000 l',                                  'Güllefass',         2.00, 'm³',    'Kostenkatalog 2025 Nr. 6079'),

  -- Güllepumpen / Mixer / Separator ---------------------------------------
  ('Tauchpumpe fahrbar, Elektromotor 9 kW',               'Güllepumpe',        1.70, 'm³',    'Kostenkatalog 2025 Nr. 6103'),
  ('Zweikolbenpumpe, doppelwirkend',                      'Güllepumpe',        0.35, 'm³',    'Kostenkatalog 2025 Nr. 6109'),
  ('Güllenmixer Elektromotor, 3–5 m, 9 kW',               'Güllepumpe',        0.75, 'm³',    'Kostenkatalog 2025 Nr. 6111'),
  ('Schiffschraubenrührwerk Elektro, 7.5 kW',             'Güllepumpe',       10.00, 'Std.',  'Kostenkatalog 2025 Nr. 6114'),

  -- Gülleverteiler / Schleppschlauch --------------------------------------
  ('Güllewerfer Dreipunkt, Handbedienung',                'Gülleverteiler',    0.30, 'm³',    'Kostenkatalog 2025 Nr. 6131'),
  ('Gülleverteiler Dreipunkt, mechanisch',                'Gülleverteiler',    0.30, 'm³',    'Kostenkatalog 2025 Nr. 6132'),
  ('Gülleverteiler Dreipunkt, elektronisch',              'Gülleverteiler',    0.50, 'm³',    'Kostenkatalog 2025 Nr. 6133'),
  ('Schleppschlauchverteiler 7 m',                        'Gülleverteiler',    0.90, 'm³',    'Kostenkatalog 2025 Nr. 6137'),
  ('Schleppschlauchverteiler 9 m',                        'Gülleverteiler',    1.00, 'm³',    'Kostenkatalog 2025 Nr. 6134'),
  ('Schleppschlauchverteiler 12 m',                       'Gülleverteiler',    1.10, 'm³',    'Kostenkatalog 2025 Nr. 6135'),
  ('Schleppschuhverteiler 7 m',                           'Gülleverteiler',    1.20, 'm³',    'Kostenkatalog 2025 Nr. 6138'),
  ('Schleppschuhverteiler 9 m',                           'Gülleverteiler',    1.20, 'm³',    'Kostenkatalog 2025 Nr. 6139'),

  -- Rohre und Schläuche / Beregnung ---------------------------------------
  ('PVC-Schlauch 100 m, ø 75 mm',                         'Gülleverteiler',    0.20, 'm³',    'Kostenkatalog 2025 Nr. 6151'),
  ('Beregnungspumpe zu Traktor, 100 m Rohr',              'Beregnung',         3.60, 'Std.',  'Kostenkatalog 2025 Nr. 6171'),
  ('Beregnungsanlage 37 Regner',                          'Beregnung',         7.00, 'Std.',  'Kostenkatalog 2025 Nr. 6173'),

  -- Kompostierung ---------------------------------------------------------
  ('Abfallschredder Zapfwelle',                           'Kompostierung',    57.00, 'Std.',  'Kostenkatalog 2025 Nr. 6181'),

  -- Mähwerke zu Traktoren (Nr. 9001–9031) ---------------------------------
  ('Doppelmessermähwerk, 2.1–2.4 m (Zweiachs)',           'Mähwerk',          61.00, 'ha',    'Kostenkatalog 2025 Nr. 9001'),
  ('Doppelmessermähwerk Heck, 1.7–2.1 m',                 'Mähwerk',          39.00, 'ha',    'Kostenkatalog 2025 Nr. 9011'),
  ('Doppelmessermähwerk Front, 2.5 m',                    'Mähwerk',          29.00, 'ha',    'Kostenkatalog 2025 Nr. 9012'),
  ('Rotationsmähwerk Front, 2.5–3.0 m',                   'Mähwerk',          28.00, 'ha',    'Kostenkatalog 2025 Nr. 9016'),
  ('Rotationsmähwerk + Aufbereiter Front, 3.5 m',         'Mähwerk',          47.00, 'ha',    'Kostenkatalog 2025 Nr. 9017'),
  ('Rotationsmähwerk Heck, 1.6–2.0 m',                    'Mähwerk',          22.00, 'ha',    'Kostenkatalog 2025 Nr. 9020'),
  ('Rotationsmähwerk Heck, 2.1–2.6 m',                    'Mähwerk',          23.00, 'ha',    'Kostenkatalog 2025 Nr. 9021'),
  ('Rotationsmähwerk + Aufbereiter Heck',                 'Mähwerk',          42.00, 'ha',    'Kostenkatalog 2025 Nr. 9022'),
  ('Mähkombination Front+Heck, 5–6 m',                    'Mähwerk',          31.00, 'ha',    'Kostenkatalog 2025 Nr. 9025'),
  ('Aufbereiter, 2 m Dreipunkt',                          'Mähwerk',          19.00, 'ha',    'Kostenkatalog 2025 Nr. 9030'),

  -- Schwader / Zetter -----------------------------------------------------
  ('Kreiselschwader, 2.8–3.3 m',                          'Schwader',         13.00, 'ha',    'Kostenkatalog 2025 Nr. 9061'),
  ('Kreiselschwader, 3.4–4.5 m',                          'Schwader',         14.00, 'ha',    'Kostenkatalog 2025 Nr. 9062'),
  ('Doppel-Kreiselschwader, 5.5–6.5 m',                   'Schwader',         18.00, 'ha',    'Kostenkatalog 2025 Nr. 9063'),
  ('Sternradrechen, 6.5–7.5 m',                           'Schwader',         12.00, 'ha',    'Kostenkatalog 2025 Nr. 9066'),
  ('Pick-up-Bandschwader Front/Heck, 3–4 m',              'Schwader',          9.00, 'ha',    'Kostenkatalog 2025 Nr. 9068'),

  -- Ladewagen / Häckselwagen ----------------------------------------------
  ('Aufbau-Ladegerät Transporter, 9.5 m³',                'Ladewagen',        18.00, 'Fuder', 'Kostenkatalog 2025 Nr. 9081'),
  ('Aufbau-Ladegerät Transporter, 13 m³',                 'Ladewagen',        30.00, 'Fuder', 'Kostenkatalog 2025 Nr. 9082'),
  ('Ladewagen Schneidvorrichtung, 15 m³',                 'Ladewagen',        23.00, 'Fuder', 'Kostenkatalog 2025 Nr. 9083'),
  ('Ladewagen Schneidvorrichtung, 20 m³',                 'Ladewagen',        22.00, 'Fuder', 'Kostenkatalog 2025 Nr. 9084'),
  ('Ladewagen Schneidvorrichtung, 25 m³',                 'Ladewagen',        29.00, 'Fuder', 'Kostenkatalog 2025 Nr. 9085'),
  ('Rotor-Ladewagen, 30 m³',                              'Ladewagen',        39.00, 'Fuder', 'Kostenkatalog 2025 Nr. 9086'),
  ('Rotor-Ladewagen, 35 m³',                              'Ladewagen',        55.00, 'Fuder', 'Kostenkatalog 2025 Nr. 9087'),
  ('Dosierentladung zu Ladewagen',                        'Ladewagen',         7.00, 'Fuder', 'Kostenkatalog 2025 Nr. 9091'),
  ('Häckselwagen Dosier., 25 m³',                         'Ladewagen',        30.00, 'Fuder', 'Kostenkatalog 2025 Nr. 9101'),
  ('Häckselwagen Dosier., 35 m³',                         'Ladewagen',        32.00, 'Fuder', 'Kostenkatalog 2025 Nr. 9102'),

  -- Pressen / Ballengeräte ------------------------------------------------
  ('Hochdruckpresse Kleinballen',                         'Ballenpresse',      0.60, 'Ballen','Kostenkatalog 2025 Nr. 9122'),
  ('Rundballenpresse klein, Schnur',                      'Ballenpresse',      1.00, 'Rundballen','Kostenkatalog 2025 Nr. 9123'),
  ('Rundballenpresse + Wickelgerät, 1.2 m',               'Ballenpresse',     13.00, 'Rundballen','Kostenkatalog 2025 Nr. 9130'),
  ('Folienwickelgerät Rundballen',                        'Ballenpresse',      2.00, 'Rundballen','Kostenkatalog 2025 Nr. 9131'),
  ('Ballenwagen zu Hochdruckpresse',                      'Ballenpresse',      0.20, 'Ballen','Kostenkatalog 2025 Nr. 9140'),
  ('Rundballen-Ladewagen (8 Ballen)',                     'Ballenpresse',      4.70, 'Rundballen','Kostenkatalog 2025 Nr. 9139'),

  -- Innenwirtschaft / Fütterung -------------------------------------------
  ('Häckselgebläse Zapfwelle, 11 kW',                     'Fütterung',        28.00, 'Std.',  'Kostenkatalog 2025 Nr. 10001'),
  ('Vielzweckgebläse Elektro, 11 kW',                     'Fütterung',        73.00, 'Std.',  'Kostenkatalog 2025 Nr. 10003'),
  ('Förderband 6 m, Elektro 1 kW',                        'Fütterung',        29.00, 'Std.',  'Kostenkatalog 2025 Nr. 10011'),
  ('Förderband 10 m, Elektro 2 kW',                       'Fütterung',        32.00, 'Std.',  'Kostenkatalog 2025 Nr. 10012'),
  ('Futtermischwagen 7 m³',                               'Fütterung',        11.00, 'Fuder', 'Kostenkatalog 2025 Nr. 10031'),
  ('Futtermischwagen 10 m³',                              'Fütterung',        13.00, 'Fuder', 'Kostenkatalog 2025 Nr. 10032'),
  ('Futtermischwagen 12 m³',                              'Fütterung',        14.00, 'Fuder', 'Kostenkatalog 2025 Nr. 10033'),
  ('Abwickel-/Verteilgerät Rundballen',                   'Fütterung',        23.00, 'Std.',  'Kostenkatalog 2025 Nr. 10047'),

  -- Stalleinrichtung / Diverses ------------------------------------------
  ('Stroh-Einstreugerät',                                 'Innenwirtschaft',  48.00, 'Std.',  'Kostenkatalog 2025 Nr. 11004'),
  ('Wisch-/Reinigungsmaschine, bis 2.25 m',               'Innenwirtschaft',  14.00, 'Std.',  'Kostenkatalog 2025 Nr. 11011'),
  ('Generator Zapfwelle, 24 kW',                          'Diverses',          7.30, 'Std.',  'Kostenkatalog 2025 Nr. 11021'),
  ('Klauenpflegestand kippbar mobil',                     'Innenwirtschaft',   2.10, 'Tier',  'Kostenkatalog 2025 Nr. 11032'),

  -- Forstwirtschaft und Bauarbeiten ---------------------------------------
  ('Kreissäge mit Elektromotor',                          'Forstwirtschaft',   7.60, 'Std.',  'Kostenkatalog 2025 Nr. 12001'),
  ('Kreissäge mit Zapfwelle',                             'Forstwirtschaft',   8.70, 'Std.',  'Kostenkatalog 2025 Nr. 12002'),
  ('Kleinholzspalter hydraulisch',                        'Forstwirtschaft',   6.00, 'm³',    'Kostenkatalog 2025 Nr. 12004'),
  ('Holzspaltmaschine, Zapfwelle',                        'Forstwirtschaft',   4.00, 'm³',    'Kostenkatalog 2025 Nr. 12005'),
  ('Holzspalter für Spälten, fahrbar',                    'Forstwirtschaft',   4.50, 'm³',    'Kostenkatalog 2025 Nr. 12007'),
  ('Schneidspalter',                                      'Forstwirtschaft',   6.50, 'm³',    'Kostenkatalog 2025 Nr. 12010'),
  ('Eintrommel-Anbauseilwinde, 4 t',                      'Forstwirtschaft',   8.00, 'Std.',  'Kostenkatalog 2025 Nr. 12022'),
  ('Eintrommel-Anbauseilwinde, 6.5 t',                    'Forstwirtschaft',  10.00, 'Std.',  'Kostenkatalog 2025 Nr. 12023'),
  ('Eintrommel-Anbauseilwinde, 8 t',                      'Forstwirtschaft',   8.50, 'Std.',  'Kostenkatalog 2025 Nr. 12033'),
  ('Doppeltrommel-Anbauseilwinde, 2×6 t',                 'Forstwirtschaft',  14.50, 'Std.',  'Kostenkatalog 2025 Nr. 12034'),
  ('Rückekran',                                           'Forstwirtschaft',  11.50, 'Std.',  'Kostenkatalog 2025 Nr. 12024'),
  ('Polterschild zu Frontlader',                          'Forstwirtschaft',   2.40, 'Std.',  'Kostenkatalog 2025 Nr. 12030'),
  ('Hydraulische Rückezange, Dreipunkt',                  'Forstwirtschaft',  17.00, 'Std.',  'Kostenkatalog 2025 Nr. 12031'),
  ('Forstanhänger mit Kran, 8–12 t',                      'Forstwirtschaft',  11.50, 'Std.',  'Kostenkatalog 2025 Nr. 12032'),
  ('Schnitzelholzhacker Zapfwelle',                       'Forstwirtschaft',  17.00, 'Std.',  'Kostenkatalog 2025 Nr. 12041'),
  ('Forstmulchgerät, bis 2.3 m',                          'Forstwirtschaft',  35.00, 'Std.',  'Kostenkatalog 2025 Nr. 12051'),
  ('Stockfräse',                                          'Forstwirtschaft',  40.00, 'Std.',  'Kostenkatalog 2025 Nr. 12053'),
  ('Pflanzlochbohrer Dreipunkt',                          'Forstwirtschaft',  34.00, 'Std.',  'Kostenkatalog 2025 Nr. 12055'),

  -- Bau-/Kleinmaschinen ---------------------------------------------------
  ('Kompaktbagger 1 t, 7.5 kW',                           'Bauarbeiten',      24.00, 'Std.',  'Kostenkatalog 2025 Nr. 12073'),
  ('Kompaktbagger 1.7 t, 12 kW',                          'Bauarbeiten',      35.00, 'Std.',  'Kostenkatalog 2025 Nr. 12074'),
  ('Raupentransporter 500 kg (Benzin)',                   'Bauarbeiten',      24.00, 'Std.',  'Kostenkatalog 2025 Nr. 12075'),
  ('Raupentransporter 700 kg, 10 kW',                     'Bauarbeiten',      33.00, 'Std.',  'Kostenkatalog 2025 Nr. 12076'),
  ('Motorseilwinde, Benzin, 7 kW',                        'Bauarbeiten',      44.00, 'Std.',  'Kostenkatalog 2025 Nr. 14005'),
  ('Motorhacke, Benzin, 5 kW',                            'Bauarbeiten',      45.00, 'Std.',  'Kostenkatalog 2025 Nr. 14006')
on conflict (name) do nothing;


-- =======================================================================
-- 6) Aufgaben (To-Dos) — Arbeiten verteilen
-- =======================================================================
create table if not exists public.aufgaben (
  id uuid primary key default gen_random_uuid(),
  titel text not null,
  beschreibung text,
  alpname text check (alpname in ('Portein', 'Sarn')),
  zugewiesen_an uuid references auth.users(id) on delete set null,   -- ein konkreter User
  frist date,
  prioritaet text not null default 'normal' check (prioritaet in ('niedrig','normal','hoch')),
  status text not null default 'offen' check (status in ('offen','erledigt')),
  erstellt_von uuid references auth.users(id) on delete set null,
  erstellt_am timestamptz not null default now(),
  erledigt_am timestamptz,
  erledigt_von uuid references auth.users(id) on delete set null
);
create index if not exists idx_aufgaben_status on public.aufgaben (status);
create index if not exists idx_aufgaben_zug on public.aufgaben (zugewiesen_an);
create index if not exists idx_aufgaben_alpname on public.aufgaben (alpname);

alter table public.aufgaben enable row level security;

-- Lesen: alle angemeldeten
drop policy if exists p_aufgaben_read on public.aufgaben;
create policy p_aufgaben_read on public.aufgaben
  for select using (public.current_rolle() is not null);

-- Schreiben (erstellen/bearbeiten/löschen): nur Alpmeister + Administrator
drop policy if exists p_aufgaben_write on public.aufgaben;
create policy p_aufgaben_write on public.aufgaben
  for all using (
    public.is_admin()
    or public.current_rolle() in ('alpmeister_portein','alpmeister_sarn')
  ) with check (
    public.is_admin()
    or public.current_rolle() in ('alpmeister_portein','alpmeister_sarn')
  );

-- Zusätzlich: jeder angemeldete User darf Aufgaben aktualisieren, wenn sie
--   (a) ihm selbst zugewiesen sind (Status ändern), oder
--   (b) noch unzugewiesen sind (Self-Claim + evtl. Status ändern).
-- Der Trigger unten schränkt ein, welche Spalten tatsächlich geändert werden dürfen.
drop policy if exists p_aufgaben_assignee on public.aufgaben;
create policy p_aufgaben_assignee on public.aufgaben
  for update using (
    zugewiesen_an = auth.uid() OR zugewiesen_an IS NULL
  ) with check (
    zugewiesen_an = auth.uid() OR zugewiesen_an IS NULL
  );


-- =======================================================================
-- SICHERHEITS-AUFRÜSTUNG (A + B + C)
-- =======================================================================
-- A) Administrator-Flag + Erstanmelder-Bootstrap
-- B) Bestösser-Update eingeschränkt auf user_id
-- C) Audit-Log
-- Alle Statements sind idempotent — kann mehrfach ausgeführt werden.
-- =======================================================================

-- ===== A) Administrator-Rechte =========================================
-- (is_admin-Spalte und is_admin()-Funktion sind bereits oben definiert.)

-- Trigger: Erster User wird automatisch Administrator.
-- Nicht-erste User können sich NICHT selbst zum Admin machen oder
-- die Rolle 'geschaeftsfuehrer' wählen.
create or replace function public.profiles_enforce_bootstrap()
returns trigger language plpgsql security definer as $fn$
begin
  if exists (select 1 from public.profiles p where p.is_admin = true) then
    new.is_admin := false;
    if new.rolle = 'geschaeftsfuehrer' then
      raise exception 'Die Rolle Geschaeftsfuehrer kann nur vom Administrator vergeben werden.';
    end if;
  else
    new.is_admin := true;
  end if;
  return new;
end
$fn$;

drop trigger if exists trg_profiles_bootstrap on public.profiles;
create trigger trg_profiles_bootstrap
  before insert on public.profiles
  for each row execute function public.profiles_enforce_bootstrap();

-- Trigger: Bei UPDATE darf ein Nicht-Administrator weder rolle noch is_admin ändern.
create or replace function public.profiles_protect_role()
returns trigger language plpgsql security definer as $fn$
begin
  if not coalesce((select p.is_admin from public.profiles p where p.id = auth.uid()), false) then
    new.rolle    := old.rolle;
    new.is_admin := old.is_admin;
  end if;
  return new;
end
$fn$;

drop trigger if exists trg_profiles_protect on public.profiles;
create trigger trg_profiles_protect
  before update on public.profiles
  for each row execute function public.profiles_protect_role();

-- Admin darf alle Profile lesen/ändern (zusätzlich zur Self-Regel)
drop policy if exists p_profiles_update_admin on public.profiles;
create policy p_profiles_update_admin on public.profiles
  for update using (public.is_admin()) with check (public.is_admin());

drop policy if exists p_profiles_delete_admin on public.profiles;
create policy p_profiles_delete_admin on public.profiles
  for delete using (public.is_admin());

-- ===== B) Bestösser-Update eingeschränkt ===============================

-- Trigger: Nicht-privilegierte Rollen dürfen bei Bestösser-Updates nur die
-- user_id ändern (Self-Claim). Alles andere wird auf die alten Werte zurückgesetzt.
create or replace function public.bestoesser_protect()
returns trigger language plpgsql security definer as $fn$
begin
  if exists (
    select 1 from public.profiles p
    where p.id = auth.uid()
      and (p.is_admin or p.rolle in ('geschaeftsfuehrer','alpmeister_portein','alpmeister_sarn'))
  ) then
    return new;
  end if;

  if new.user_id is distinct from auth.uid() then
    raise exception 'Nicht erlaubt: Nur Zuordnung des eigenen Accounts moeglich.';
  end if;
  new.name    := old.name;
  new.nst     := old.nst;
  new.alpname := old.alpname;
  new.jahr    := old.jahr;
  new.aktiv   := old.aktiv;
  return new;
end
$fn$;

drop trigger if exists trg_bestoesser_protect on public.bestoesser;
create trigger trg_bestoesser_protect
  before update on public.bestoesser
  for each row execute function public.bestoesser_protect();

-- Admin kann Bestösser wie GF verwalten
drop policy if exists p_bestoesser_admin_write on public.bestoesser;
create policy p_bestoesser_admin_write on public.bestoesser
  for all using (public.is_admin()) with check (public.is_admin());

-- Admin / GF können die Master-Tabellen verwalten (beide zusammen)
drop policy if exists p_arbeitsarten_admin on public.arbeitsarten;
create policy p_arbeitsarten_admin on public.arbeitsarten
  for all using (public.is_admin()) with check (public.is_admin());

drop policy if exists p_maschinen_admin on public.maschinen;
create policy p_maschinen_admin on public.maschinen
  for all using (public.is_admin()) with check (public.is_admin());

drop policy if exists p_eintraege_admin on public.eintraege;
create policy p_eintraege_admin on public.eintraege
  for all using (public.is_admin()) with check (public.is_admin());

-- ===== C) Audit-Log ====================================================

create table if not exists public.audit_log (
  id uuid primary key default gen_random_uuid(),
  tabelle text not null,
  aktion text not null check (aktion in ('INSERT','UPDATE','DELETE')),
  record_id uuid,
  user_id uuid references auth.users(id) on delete set null,
  user_name text,
  rolle text,
  alt jsonb,
  neu jsonb,
  zeit timestamptz not null default now()
);
create index if not exists idx_audit_zeit on public.audit_log (zeit desc);
create index if not exists idx_audit_tabelle on public.audit_log (tabelle);

alter table public.audit_log enable row level security;

-- Lesen: Admin + Geschäftsführer
drop policy if exists p_audit_read on public.audit_log;
create policy p_audit_read on public.audit_log
  for select using (
    public.is_admin() or public.current_rolle() = 'geschaeftsfuehrer'
  );

-- Kein direkter Schreibzugriff — der Trigger ist SECURITY DEFINER und
-- umgeht RLS. (Keine INSERT/UPDATE/DELETE-Policies → alles verboten.)

-- Audit-Trigger-Funktion
create or replace function public.audit_changes()
returns trigger language plpgsql security definer as $fn$
begin
  insert into public.audit_log (tabelle, aktion, record_id, user_id, user_name, rolle, alt, neu)
  values (
    tg_table_name,
    tg_op,
    case tg_op when 'DELETE' then (old).id else (new).id end,
    auth.uid(),
    (select p.name from public.profiles p where p.id = auth.uid()),
    (select p.rolle from public.profiles p where p.id = auth.uid()),
    case when tg_op in ('UPDATE','DELETE') then to_jsonb(old) else null end,
    case when tg_op in ('INSERT','UPDATE') then to_jsonb(new) else null end
  );
  return coalesce(new, old);
end
$fn$;

-- Trigger auf allen sensitiven Tabellen
drop trigger if exists trg_audit_eintraege on public.eintraege;
create trigger trg_audit_eintraege after insert or update or delete on public.eintraege
  for each row execute function public.audit_changes();

drop trigger if exists trg_audit_bestoesser on public.bestoesser;
create trigger trg_audit_bestoesser after insert or update or delete on public.bestoesser
  for each row execute function public.audit_changes();

drop trigger if exists trg_audit_maschinen on public.maschinen;
create trigger trg_audit_maschinen after insert or update or delete on public.maschinen
  for each row execute function public.audit_changes();

drop trigger if exists trg_audit_profiles on public.profiles;
create trigger trg_audit_profiles after insert or update or delete on public.profiles
  for each row execute function public.audit_changes();

drop trigger if exists trg_audit_arbeitsarten on public.arbeitsarten;
create trigger trg_audit_arbeitsarten after insert or update or delete on public.arbeitsarten
  for each row execute function public.audit_changes();

drop trigger if exists trg_audit_aufgaben on public.aufgaben;
create trigger trg_audit_aufgaben after insert or update or delete on public.aufgaben
  for each row execute function public.audit_changes();

-- Schutz-Trigger für Aufgaben: Wenn der Aktualisierende kein
-- Admin/GF/Alpmeister ist, dürfen nur status, erledigt_am/von und ein
-- Self-Claim (zugewiesen_an von NULL auf auth.uid()) geändert werden.
create or replace function public.aufgaben_protect()
returns trigger language plpgsql security definer as $fn$
begin
  if exists (
    select 1 from public.profiles p
    where p.id = auth.uid()
      and (p.is_admin or p.rolle in ('geschaeftsfuehrer','alpmeister_portein','alpmeister_sarn'))
  ) then
    return new;
  end if;

  new.titel          := old.titel;
  new.beschreibung   := old.beschreibung;
  new.alpname        := old.alpname;
  new.frist          := old.frist;
  new.prioritaet     := old.prioritaet;
  new.erstellt_von   := old.erstellt_von;
  new.erstellt_am    := old.erstellt_am;

  if new.zugewiesen_an is distinct from old.zugewiesen_an then
    if old.zugewiesen_an is null and new.zugewiesen_an = auth.uid() then
      null;
    else
      new.zugewiesen_an := old.zugewiesen_an;
    end if;
  end if;

  if new.status = 'erledigt' and old.status <> 'erledigt' then
    new.erledigt_am := now();
    new.erledigt_von := auth.uid();
  elsif new.status = 'offen' then
    new.erledigt_am := null;
    new.erledigt_von := null;
  end if;
  return new;
end
$fn$;

drop trigger if exists trg_aufgaben_protect on public.aufgaben;
create trigger trg_aufgaben_protect
  before update on public.aufgaben
  for each row execute function public.aufgaben_protect();
