-- =============================================================================
-- External consultation time slots + payment status, and consultant details
-- Migration: 20260907000400_consultation_slots_and_consultant_details.sql
--
-- 1. EXTERNAL CONSULTATIONS RESERVE A TIME, AND THAT TIME IS BLOCKED
--    Recording an external consultation captured a DATE and an amount, and
--    nothing else. Nothing stopped a receptionist booking a patient into the
--    same afternoon the dentist was consulting elsewhere.
--
--    The scheduling half of this already exists and is NOT rebuilt here.
--    `consultancy_schedules` (20260706000000, moved to specific dates by
--    20260707000000) is already read by getAvailableSlots — its ranges are
--    subtracted from every booking channel, dentist, receptionist and portal
--    alike. So an external consultation now OPTIONALLY carries a start and end
--    time, and when it does, the action writes the matching
--    `consultancy_schedules` row and links it. One scheduling system, not two.
--
--    `schedule_id` is the link, with ON DELETE SET NULL: removing a block must
--    not delete the income record, and the two are edited from different
--    screens.
--
-- 2. AMOUNT BECOMES OPTIONAL, AND GAINS A PAYMENT STATUS
--    `amount` was NOT NULL, so a consultation could not be recorded before the
--    fee was known — which is the normal case when the slot is reserved in
--    advance. It becomes nullable, and `is_paid` records whether the money has
--    actually arrived. The two are independent on purpose: an amount that is
--    known is not an amount that is paid, and conflating them is how a
--    receivable disappears.
--
--    The existing `check (amount >= 0)` is retained in a NULL-tolerant form —
--    a CHECK passes on NULL, so `amount is null or amount >= 0` is the same
--    constraint for every row that has a value.
--
--    getConsultancyRevenueToday sums this column; SUM ignores NULLs, so an
--    unpriced consultation contributes nothing rather than breaking the total.
--
-- 3. CONSULTANTS GAIN A DESIGNATION AND A PHONE NUMBER
--    Both nullable. Phone is explicitly optional; designation is too, so the
--    consultants already in the directory stay valid without a backfill.
-- =============================================================================

-- =============================================================================
-- 1. CONSULTANCY INCOME — time slot, payment status, optional amount
-- =============================================================================

alter table consultancy_income
  add column if not exists start_time  time,
  add column if not exists end_time    time,
  add column if not exists is_paid     boolean not null default false,
  add column if not exists schedule_id uuid
    references consultancy_schedules (id) on delete set null;

-- Both ends of a slot, or neither. A start with no end cannot block anything,
-- and would render as a half-stated time on the list.
alter table consultancy_income
  drop constraint if exists chk_consultancy_income_slot;
alter table consultancy_income
  add constraint chk_consultancy_income_slot check (
    (start_time is null and end_time is null)
    or (start_time is not null and end_time is not null and end_time > start_time)
  );

-- Amount becomes optional: the slot is often reserved before the fee is agreed.
alter table consultancy_income
  alter column amount drop not null;

-- The original NOT NULL column carried `check (amount >= 0)`. Restate it so it
-- tolerates NULL explicitly rather than relying on the reader knowing that a
-- CHECK passes on NULL.
alter table consultancy_income
  drop constraint if exists consultancy_income_amount_check;
alter table consultancy_income
  add constraint consultancy_income_amount_check check (amount is null or amount >= 0);

comment on column consultancy_income.amount is
  'Fee earned, in local currency. NULL when the consultation is booked but the '
  'amount is not yet known — editable afterwards. Revenue totals use SUM, which '
  'ignores NULL, so an unpriced row contributes nothing.';

comment on column consultancy_income.is_paid is
  'Whether the fee has actually been received. Independent of `amount`: an '
  'amount that is known is not an amount that is paid.';

comment on column consultancy_income.schedule_id is
  'The consultancy_schedules row blocking this slot, when a time was reserved. '
  'ON DELETE SET NULL — removing the block must not delete the income record.';

create index if not exists consultancy_income_unpaid_idx
  on consultancy_income (clinic_id, dentist_id)
  where is_paid = false;

-- =============================================================================
-- 2. CONSULTANTS — designation and phone
-- =============================================================================

alter table consultants
  add column if not exists designation text,
  add column if not exists phone       text;

comment on column consultants.designation is
  'Professional designation, e.g. "Endodontist". Optional — existing rows '
  'predate the field and stay valid.';

comment on column consultants.phone is
  'Contact number. Explicitly OPTIONAL: a consultant is a directory entry for '
  'revenue allocation, not a messaging recipient.';

-- =============================================================================
-- 3. COLUMN GRANTS
-- =============================================================================
-- 20260907000100 revoked the table-level SELECT on `appointments` and
-- `treatments` and re-granted per column, which means a column added to EITHER
-- of those tables is unreadable until granted. Neither table is touched here —
-- `consultancy_income` and `consultants` still hold table-level grants, so
-- their new columns are readable automatically. Noted so the next person adding
-- a column does not have to work out whether they need this.

-- =============================================================================
-- END OF MIGRATION
-- =============================================================================
