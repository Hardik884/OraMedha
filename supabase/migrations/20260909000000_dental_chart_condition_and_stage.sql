-- =============================================================================
-- DentGrow — Dental Chart: split "condition" and "treatment status" apart
-- Migration: 20260909000000_dental_chart_condition_and_stage.sql
--
-- WHY
--   patient_teeth.status (tooth_status: normal/recommended/planned/
--   in_progress/completed/missing) conflated two different questions —
--   "what is wrong with this tooth" (normal, missing) and "what stage is its
--   treatment at" (recommended, planned, in_progress, completed) — into one
--   enum, and the actual clinical condition (caries, a fracture, a crown...)
--   lived in a free-text column with no fixed vocabulary. The Dental Chart UI
--   now asks two separate, fixed-vocabulary questions per tooth, so the data
--   model is split to match:
--
--     tooth_condition  — what the tooth IS (a closed set of 9 values,
--                         defaulting to 'normal').
--     treatment_stage   — what stage its treatment is at, if any (a closed
--                         set of 4 values, nullable — a normal tooth or one
--                         with a condition but no treatment underway has no
--                         stage).
--
--   Additive only. The original `status` (tooth_status) and free-text
--   `condition` columns are left in place, untouched, for audit continuity —
--   tooth_history rows recorded before this migration describe THOSE columns
--   and must keep reading correctly. Nothing here is dropped or renamed.
--
-- BACKFILL
--   Every existing patient_teeth row is given a best-effort tooth_condition
--   and treatment_stage so it displays correctly under the new two-dropdown
--   UI without a dentist having to re-chart it:
--     - status = 'missing'   -> tooth_condition = 'missing_extracted'
--     - status = 'normal'    -> tooth_condition = 'normal'
--     - status IN (the four treatment-stage values) -> treatment_stage is a
--       direct copy (the values are identical), and tooth_condition is a
--       best-effort keyword match against the old free-text `condition`
--       column, falling back to 'normal' when nothing matches. The original
--       free-text value is NOT discarded — the `condition` column still
--       holds it, and the app surfaces it read-only where relevant.
-- =============================================================================

-- =============================================================================
-- 1. ENUMS
-- =============================================================================

create type tooth_condition as enum (
  'normal',
  'caries',
  'fractured',
  'restored_filled',
  'crown',
  'root_canal_treated',
  'abscess',
  'missing_extracted',
  'implant'
);

comment on type tooth_condition is
  'Fixed clinical condition vocabulary for a charted tooth. Distinct from '
  'treatment_stage: a tooth can carry a condition (e.g. crown) with no '
  'treatment currently underway.';

create type tooth_treatment_stage as enum (
  'recommended',
  'planned',
  'in_progress',
  'completed'
);

comment on type tooth_treatment_stage is
  'Stage of treatment for a tooth''s current condition, if any is underway. '
  'Nullable on patient_teeth — a tooth with no treatment in progress (e.g. '
  'condition = normal) has no stage.';

-- =============================================================================
-- 2. PATIENT_TEETH — additive columns
-- =============================================================================

alter table patient_teeth
  add column tooth_condition   tooth_condition        not null default 'normal',
  add column treatment_stage   tooth_treatment_stage;

comment on column patient_teeth.tooth_condition is
  'Fixed-vocabulary clinical condition (see tooth_condition enum). Replaces '
  'the free-text `condition` column as the field the Dental Chart UI edits; '
  '`condition` is kept, untouched, for records charted before this column '
  'existed.';
comment on column patient_teeth.treatment_stage is
  'Fixed-vocabulary treatment stage (see tooth_treatment_stage enum), or '
  'null when no treatment is underway for this tooth. Replaces the subset '
  'of the legacy `status` column that described a treatment stage; `status` '
  'is kept, untouched, for records charted before this column existed.';

-- =============================================================================
-- 3. BACKFILL — best-effort, non-destructive
-- =============================================================================

update patient_teeth
set tooth_condition = 'missing_extracted'
where status = 'missing';

update patient_teeth
set tooth_condition = 'normal'
where status = 'normal';

update patient_teeth
set treatment_stage = status::text::tooth_treatment_stage
where status in ('recommended', 'planned', 'in_progress', 'completed');

-- Best-effort keyword match against the old free-text `condition` column for
-- every row that was mid-treatment. Order matters (root canal before
-- "canal"-adjacent generic terms); the first match wins. Anything unmatched
-- keeps the column default ('normal') rather than guessing further — the
-- original text remains readable in the untouched `condition` column.
update patient_teeth
set tooth_condition = (
  case
    when condition ilike '%root canal%' or condition ilike '%rct%' or condition ilike '% endo%' then 'root_canal_treated'
    when condition ilike '%crown%' then 'crown'
    when condition ilike '%implant%' then 'implant'
    when condition ilike '%abscess%' or condition ilike '%infect%' then 'abscess'
    when condition ilike '%fract%' or condition ilike '%crack%' or condition ilike '%chip%' then 'fractured'
    when condition ilike '%fill%' or condition ilike '%restor%' then 'restored_filled'
    when condition ilike '%car%' or condition ilike '%cavit%' or condition ilike '%decay%' then 'caries'
    else 'normal'
  end
)::tooth_condition
where status in ('recommended', 'planned', 'in_progress', 'completed')
  and condition is not null;

-- =============================================================================
-- 4. PATIENT PORTAL VIEW — add the new columns, keep the old ones
-- =============================================================================

-- `create or replace view` cannot reorder or insert columns ahead of
-- existing ones — Postgres errors "cannot change name of view column" if a
-- new column's ordinal position lands before an existing one. The two new
-- columns are therefore appended after `updated_at`, not inserted next to
-- the legacy pair they replace.
create or replace view patient_dental_chart
with (security_invoker = true)
as
  select
    id,
    patient_id,
    dentition_type,
    tooth_number,
    status,
    condition,          -- legacy — `notes` deliberately excluded, dentist-only
    updated_at,
    tooth_condition,
    treatment_stage
  from patient_teeth
  where deleted_at is null
    and patient_id = auth_patient_id();

comment on view patient_dental_chart is
  'Portal-safe dental chart view. Excludes the dentist-only `notes` column, '
  'mirroring patient_treatments'' exclusion of internal_notes. Always query '
  'this view from patient-facing code, never patient_teeth directly.';
