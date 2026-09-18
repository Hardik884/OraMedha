-- =============================================================================
-- DentGrow — LOCAL DEVELOPMENT SEED
--
-- Runs automatically after migrations on `supabase db reset` / `supabase start`.
-- It is NEVER executed by `supabase db push`, so it cannot reach a hosted project
-- through the normal deploy path.
--
-- ⚠ These are throwaway credentials for a disposable local database. Never point
--   `db reset` at a linked remote project — it drops and recreates the database.
--
-- Clinics themselves are NOT seeded here: 20260627000000_multi_clinic_pilot.sql
-- already inserts both pilot clinics idempotently, so they exist after migrations
-- and are identical in every environment. This file only adds the auth users and
-- profiles needed to actually sign in locally.
--
-- Local sign-in credentials (all passwords: `password123`):
--   dentist@dentgrow.test       — dentist,      Dr. Liying's Dental Care   → /login
--   receptionist@dentgrow.test  — receptionist, Dr. Liying's Dental Care   → /login
--   brain@dentgrow.test         — dentist,      My Dental Clinic           → /login
--   patient@dentgrow.test       — patient,      Dr. Liying's Dental Care   → /patient/login
--   owner@dentgrow.local        — admin,        My Dental Clinic           → /admin/login
--
-- No sign-in page asks for a clinic any more. The clinic is resolved server-side
-- from profiles.clinic_id (actions/auth.ts). A clinic is chosen ONLY on the new
-- patient signup form (/patient/signup), and validated server-side there.
-- =============================================================================

-- Refuse to run against a database that already holds real data. `db reset`
-- against a linked project is destructive, and this seed would inject known
-- credentials into it. A freshly migrated local database has zero patients, so
-- this never misfires locally while still refusing to touch a populated clinic.
--
-- (Deliberately not a superuser check: Supabase's local `postgres` role is not
-- flagged usesuper, so that test aborts the normal local workflow.)
do $$
declare
  v_patients bigint;
begin
  select count(*) into v_patients from patients;
  if v_patients > 0 then
    raise exception
      'seed.sql refused to run: this database already contains % patient row(s), '
      'so it is not an empty local database. Seeds must never run against an '
      'environment with real clinic data.', v_patients;
  end if;
end $$;

-- ── Auth users ────────────────────────────────────────────────────────────────
-- Passwords are hashed with pgcrypto's crypt(), the same scheme GoTrue uses.
-- A matching auth.identities row is required or the user cannot sign in.

insert into auth.users (
  instance_id, id, aud, role, email, encrypted_password,
  email_confirmed_at, created_at, updated_at,
  raw_app_meta_data, raw_user_meta_data, is_sso_user, is_anonymous
)
values
  (
    '00000000-0000-0000-0000-000000000000',
    'dddddddd-0000-0000-0000-000000000001',
    'authenticated', 'authenticated',
    'dentist@dentgrow.test',
    extensions.crypt('password123', extensions.gen_salt('bf')),
    now(), now(), now(),
    '{"provider":"email","providers":["email"]}'::jsonb,
    '{"full_name":"Dr. Liying"}'::jsonb,
    false, false
  ),
  (
    '00000000-0000-0000-0000-000000000000',
    'eeeeeeee-0000-0000-0000-000000000001',
    'authenticated', 'authenticated',
    'receptionist@dentgrow.test',
    extensions.crypt('password123', extensions.gen_salt('bf')),
    now(), now(), now(),
    '{"provider":"email","providers":["email"]}'::jsonb,
    '{"full_name":"Front Desk"}'::jsonb,
    false, false
  )
on conflict (id) do nothing;

insert into auth.identities (
  id, user_id, identity_data, provider, provider_id,
  last_sign_in_at, created_at, updated_at
)
select
  u.id, u.id,
  jsonb_build_object('sub', u.id::text, 'email', u.email, 'email_verified', true),
  'email', u.email,
  now(), now(), now()
from auth.users u
where u.email in ('dentist@dentgrow.test', 'receptionist@dentgrow.test')
on conflict (provider, provider_id) do nothing;

-- ── Profiles ──────────────────────────────────────────────────────────────────
-- clinic_id points at the pilot clinic seeded by 20260627000000.
-- Written directly (not through RLS) because seeds run as the table owner.

insert into profiles (id, clinic_id, full_name, role)
select
  u.id,
  '11111111-1111-1111-1111-111111111111',
  case u.email
    when 'dentist@dentgrow.test' then 'Dr. Liying'
    else 'Front Desk'
  end,
  case u.email
    when 'dentist@dentgrow.test' then 'dentist'::user_role
    else 'receptionist'::user_role
  end
from auth.users u
where u.email in ('dentist@dentgrow.test', 'receptionist@dentgrow.test')
on conflict (id) do nothing;

-- =============================================================================
-- Demo Clinic (sample data)
--
-- The clinic row and its settings only. `scripts/seed-demo-clinic.mjs` fills it
-- with nine months of generated activity; that is far too much to carry in a
-- seed file, and it belongs in a script anyone can re-run against any
-- environment.
--
-- It exists here because the clinic is on the Business Brain allow-list
-- (lib/feature-flags.ts), and the hourly metric-history job walks that list. A
-- clinic on the list with no row in this database used to make the job report a
-- failed run, every hour, on every environment where nobody had run the seeder.
-- The job now skips a clinic it cannot find; this makes local and CI match
-- production instead of relying on that.
-- =============================================================================

insert into clinics (id, name, dentist_name)
values ('d0000000-0000-4000-8000-0000000000d0', 'Demo Clinic (sample data)', 'Dr Demo (sample data)')
on conflict (id) do nothing;

insert into clinic_settings (
  clinic_id, clinic_name, timezone, average_appointment_duration, chair_count
)
values (
  'd0000000-0000-4000-8000-0000000000d0', 'Demo Clinic (sample data)', 'Asia/Kolkata', 30, 1
)
on conflict (clinic_id) do nothing;

-- =============================================================================
-- Business Brain demo clinic
--
-- "My Dental Clinic" is the development clinic the Business Brain dashboard is
-- allow-listed to (lib/feature-flags.ts). It exists in the hosted project but is
-- not created by any migration, so without this block the dashboard 404s locally
-- and the feature cannot be developed or reviewed.
--
-- The activity below is deliberately a clinic having a thin day — low booking
-- volume against open capacity, unpaid completed work, a queue that is backing
-- up — so the pipeline actually produces signals and a diagnosis to look at. An
-- empty clinic renders the "nothing needs attention" state, which is correct but
-- shows nothing of how the analysis reads.
--
-- Local sign-in: brain@dentgrow.test / password123 (clinic: My Dental Clinic)
-- =============================================================================

insert into clinics (id, name, dentist_name)
values ('00000000-0000-0000-0000-000000000001', 'My Dental Clinic', 'Dr. Demo')
on conflict (id) do nothing;

-- Two chairs, so the demo clinic exercises the chair multiplier in capacity
-- metrics rather than the default single-chair path.
--
-- consent_forms_enabled = true: the pilot flag (see migration
-- 20260816010000) is on for the REAL pilot clinic ('22222222-...') on every
-- environment; it is also enabled here for the local demo clinic so local
-- development and the e2e suite (which logs in as this clinic) can exercise
-- Patient Consent Forms without a manual toggle.
insert into clinic_settings (
  clinic_id, clinic_name, timezone, average_appointment_duration, chair_count, consent_forms_enabled
)
values ('00000000-0000-0000-0000-000000000001', 'My Dental Clinic', 'Asia/Kolkata', 30, 2, true)
on conflict (clinic_id) do nothing;

insert into auth.users (
  instance_id, id, aud, role, email, encrypted_password,
  email_confirmed_at, created_at, updated_at,
  raw_app_meta_data, raw_user_meta_data, is_sso_user, is_anonymous
)
values (
  '00000000-0000-0000-0000-000000000000',
  'bbbbbbbb-0000-0000-0000-000000000001',
  'authenticated', 'authenticated',
  'brain@dentgrow.test',
  extensions.crypt('password123', extensions.gen_salt('bf')),
  now(), now(), now(),
  '{"provider":"email","providers":["email"]}'::jsonb,
  '{"full_name":"Dr. Demo"}'::jsonb,
  false, false
)
on conflict (id) do nothing;

insert into auth.identities (
  id, user_id, identity_data, provider, provider_id,
  last_sign_in_at, created_at, updated_at
)
select
  u.id, u.id,
  jsonb_build_object('sub', u.id::text, 'email', u.email, 'email_verified', true),
  'email', u.email, now(), now(), now()
from auth.users u
where u.email = 'brain@dentgrow.test'
on conflict (provider, provider_id) do nothing;

insert into profiles (id, clinic_id, full_name, role)
values (
  'bbbbbbbb-0000-0000-0000-000000000001',
  '00000000-0000-0000-0000-000000000001',
  'Dr. Demo',
  'dentist'
)
on conflict (id) do nothing;

-- Open every weekday 09:00–17:00 at 30 minutes: 16 slots a day.
insert into availability_rules (clinic_id, day_of_week, start_time, end_time, slot_duration_minutes)
select '00000000-0000-0000-0000-000000000001', d, '09:00', '17:00', 30
from generate_series(1, 5) as d
on conflict do nothing;

-- Patients: two lapsed (last seen well over the recall interval) so the
-- reactivation metric has something real to count.
insert into patients (id, clinic_id, name, phone, created_at, last_visit, total_visits)
values
  ('b0000000-0000-4000-8000-000000000001', '00000000-0000-0000-0000-000000000001', 'Asha Menon',   '9990000001', now() - interval '400 days', now() - interval '300 days', 3),
  ('b0000000-0000-4000-8000-000000000002', '00000000-0000-0000-0000-000000000001', 'Rahul Verma',  '9990000002', now() - interval '380 days', now() - interval '260 days', 2),
  ('b0000000-0000-4000-8000-000000000003', '00000000-0000-0000-0000-000000000001', 'Priya Nair',   '9990000003', now() - interval '200 days', now() - interval '20 days',  5),
  ('b0000000-0000-4000-8000-000000000004', '00000000-0000-0000-0000-000000000001', 'Imran Sheikh', '9990000004', now() - interval '90 days',  now() - interval '5 days',   2)
on conflict (id) do nothing;

-- Today: two booked appointments against 16 slots — thin volume, low utilization.
insert into appointments (id, clinic_id, patient_id, dentist_id, scheduled_at, source, status, created_at)
values
  ('b1000000-0000-4000-8000-000000000001', '00000000-0000-0000-0000-000000000001', 'b0000000-0000-4000-8000-000000000003', 'bbbbbbbb-0000-0000-0000-000000000001', date_trunc('day', now()) + interval '10 hours', 'walk_in',  'completed', now() - interval '1 day'),
  ('b1000000-0000-4000-8000-000000000002', '00000000-0000-0000-0000-000000000001', 'b0000000-0000-4000-8000-000000000004', 'bbbbbbbb-0000-0000-0000-000000000001', date_trunc('day', now()) + interval '11 hours', 'referral', 'checked_in', now() - interval '2 days')
on conflict (id) do nothing;

-- Work delivered today but unpaid, plus a large accepted-but-unstarted plan.
insert into treatments (id, clinic_id, appointment_id, patient_id, treatment_type, cost, status, performed_at)
values
  ('b2000000-0000-4000-8000-000000000001', '00000000-0000-0000-0000-000000000001', 'b1000000-0000-4000-8000-000000000001', 'b0000000-0000-4000-8000-000000000003', 'Root Canal',       9000,  'completed', now()),
  ('b2000000-0000-4000-8000-000000000002', '00000000-0000-0000-0000-000000000001', 'b1000000-0000-4000-8000-000000000001', 'b0000000-0000-4000-8000-000000000003', 'Crown',            22000, 'planned',   null),
  ('b2000000-0000-4000-8000-000000000003', '00000000-0000-0000-0000-000000000001', 'b1000000-0000-4000-8000-000000000002', 'b0000000-0000-4000-8000-000000000004', 'Full Mouth Rehab', 45000, 'planned',   null)
on conflict (id) do nothing;

-- Both of today's patients are waiting, and have been for a while.
insert into queue_entries (id, clinic_id, appointment_id, patient_id, position, status, queue_date, checked_in_at)
values
  ('b3000000-0000-4000-8000-000000000001', '00000000-0000-0000-0000-000000000001', 'b1000000-0000-4000-8000-000000000001', 'b0000000-0000-4000-8000-000000000003', 1, 'waiting', current_date, now() - interval '45 minutes'),
  ('b3000000-0000-4000-8000-000000000002', '00000000-0000-0000-0000-000000000001', 'b1000000-0000-4000-8000-000000000002', 'b0000000-0000-4000-8000-000000000004', 2, 'waiting', current_date, now() - interval '30 minutes')
on conflict (id) do nothing;

-- Recall that has slipped.
insert into follow_ups (id, clinic_id, patient_id, due_date, status, notes)
values
  ('b4000000-0000-4000-8000-000000000001', '00000000-0000-0000-0000-000000000001', 'b0000000-0000-4000-8000-000000000001', current_date - 40, 'pending', 'Six-month recall'),
  ('b4000000-0000-4000-8000-000000000002', '00000000-0000-0000-0000-000000000001', 'b0000000-0000-4000-8000-000000000002', current_date - 12, 'pending', 'Crown review')
on conflict (id) do nothing;

-- =============================================================================
-- Platform admin account — owner@dentgrow.local
--
-- On the hosted project this account already exists and migration
-- 20260821000000 grants it the admin flag. A fresh local database has no such
-- row (the migration's grant is a no-op here), so it is seeded below with the
-- SAME shape: dentist of "My Dental Clinic", plus is_admin = true.
--
-- Keeping role = 'dentist' is deliberate. Admin is an additive capability, not
-- a replacement role: the account must keep its dev-clinic access (Business
-- Brain is allow-listed to this clinic) while ALSO being the only account that
-- can reach the /admin portal.
--
-- Local sign-in: owner@dentgrow.local / password123  →  /admin/login only.
-- (The hosted account keeps its own real password; nothing here touches it.)
-- =============================================================================

insert into auth.users (
  instance_id, id, aud, role, email, encrypted_password,
  email_confirmed_at, created_at, updated_at,
  raw_app_meta_data, raw_user_meta_data, is_sso_user, is_anonymous
)
values (
  '00000000-0000-0000-0000-000000000000',
  'aaaaaaaa-0000-0000-0000-000000000001',
  'authenticated', 'authenticated',
  'owner@dentgrow.local',
  extensions.crypt('password123', extensions.gen_salt('bf')),
  now(), now(), now(),
  '{"provider":"email","providers":["email"]}'::jsonb,
  '{"full_name":"DentGrow Owner"}'::jsonb,
  false, false
)
on conflict (id) do nothing;

insert into auth.identities (
  id, user_id, identity_data, provider, provider_id,
  last_sign_in_at, created_at, updated_at
)
select
  u.id, u.id,
  jsonb_build_object('sub', u.id::text, 'email', u.email, 'email_verified', true),
  'email', u.email, now(), now(), now()
from auth.users u
where u.email = 'owner@dentgrow.local'
on conflict (provider, provider_id) do nothing;

insert into profiles (id, clinic_id, full_name, role, is_admin)
values (
  'aaaaaaaa-0000-0000-0000-000000000001',
  '00000000-0000-0000-0000-000000000001',
  'DentGrow Owner',
  'dentist',
  true
)
on conflict (id) do update set is_admin = true;

-- =============================================================================
-- Existing patient portal account — patient@dentgrow.test
--
-- Models the "already registered" patient: a patients row created by the clinic
-- PLUS a patient_portal_links row joining it to an auth account. This is the
-- account the patient-login regression test signs in with — it must reach
-- /portal directly, never /portal/setup, and never be asked for a clinic.
--
-- Local sign-in: patient@dentgrow.test / password123  (Dr. Liying's Dental Care)
-- =============================================================================

insert into auth.users (
  instance_id, id, aud, role, email, encrypted_password,
  email_confirmed_at, created_at, updated_at,
  raw_app_meta_data, raw_user_meta_data, is_sso_user, is_anonymous
)
values (
  '00000000-0000-0000-0000-000000000000',
  'cccccccc-0000-0000-0000-000000000001',
  'authenticated', 'authenticated',
  'patient@dentgrow.test',
  extensions.crypt('password123', extensions.gen_salt('bf')),
  now(), now(), now(),
  '{"provider":"email","providers":["email"]}'::jsonb,
  '{"full_name":"Meera Patel"}'::jsonb,
  false, false
)
on conflict (id) do nothing;

insert into auth.identities (
  id, user_id, identity_data, provider, provider_id,
  last_sign_in_at, created_at, updated_at
)
select
  u.id, u.id,
  jsonb_build_object('sub', u.id::text, 'email', u.email, 'email_verified', true),
  'email', u.email, now(), now(), now()
from auth.users u
where u.email = 'patient@dentgrow.test'
on conflict (provider, provider_id) do nothing;

insert into profiles (id, clinic_id, full_name, role)
values (
  'cccccccc-0000-0000-0000-000000000001',
  '11111111-1111-1111-1111-111111111111',
  'Meera Patel',
  'patient'
)
on conflict (id) do nothing;

insert into patients (id, clinic_id, name, phone, date_of_birth, gender, total_visits)
values (
  'cccccccc-0000-4000-8000-000000000001',
  '11111111-1111-1111-1111-111111111111',
  'Meera Patel',
  '9812345670',
  '1991-03-14',
  'female',
  2
)
on conflict (id) do nothing;

insert into patient_portal_links (patient_id, user_id)
values (
  'cccccccc-0000-4000-8000-000000000001',
  'cccccccc-0000-0000-0000-000000000001'
)
on conflict (patient_id) do nothing;

-- GoTrue reads several auth.users varchar columns into Go strings and cannot
-- scan NULL into one: leaving them unset makes every sign-in fail with
-- "Database error querying schema" (HTTP 500), even though the row looks
-- correct in psql. They must be empty strings, not NULL.
update auth.users
set confirmation_token     = coalesce(confirmation_token, ''),
    recovery_token         = coalesce(recovery_token, ''),
    email_change           = coalesce(email_change, ''),
    email_change_token_new = coalesce(email_change_token_new, ''),
    email_change_token_current = coalesce(email_change_token_current, ''),
    phone_change           = coalesce(phone_change, ''),
    phone_change_token     = coalesce(phone_change_token, ''),
    reauthentication_token = coalesce(reauthentication_token, '')
where confirmation_token is null
   or recovery_token is null
   or email_change is null
   or email_change_token_new is null
   or email_change_token_current is null
   or phone_change is null
   or phone_change_token is null
   or reauthentication_token is null;
