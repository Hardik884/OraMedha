-- =============================================================================
-- Queue entries are removed from the live queue, not erased
-- Migration: 20260918100100_queue_soft_removal.sql
--
-- WHY
--   Cancelling or no-showing an appointment whose patient had already checked in
--   hard-deleted the queue entry. The check-in happened; erasing it removed every
--   patient who waited and then left from the waiting-time evidence, so waits
--   looked shorter than they were. The nightly no-show job's defensive cleanup was
--   worse: it stamped `completed_at` on an entry nobody completed.
--
-- WHAT
--   `removed_at` marks an entry taken off the live queue. Live queue reads filter
--   `removed_at is null`; historical readers keep the row and know it was
--   removed, and when. Nothing about the check-in or call-in is altered.
--
--   The one-in-progress-per-clinic-per-day index ignores removed entries, so a
--   removal can never block the next patient being called.
--
--   Existing rows are untouched: a queue entry deleted before this migration is
--   gone, and nothing reconstructs it.
-- =============================================================================

alter table queue_entries
  add column if not exists removed_at timestamptz;

comment on column queue_entries.removed_at is
  'When the entry was taken off the live queue (its appointment cancelled or missed, '
  'or its patient deleted). Null = still part of the day''s queue. The row is kept as '
  'evidence that the patient checked in.';

alter table queue_entries drop constraint if exists chk_queue_removed_after_check_in;
alter table queue_entries
  add constraint chk_queue_removed_after_check_in
  check (removed_at is null or removed_at >= checked_in_at);

drop index if exists uq_queue_clinic_in_progress_per_day;
create unique index uq_queue_clinic_in_progress_per_day
  on queue_entries (clinic_id, queue_date)
  where status = 'in_progress' and removed_at is null;

comment on index uq_queue_clinic_in_progress_per_day is
  'Enforces at most one live in_progress entry per clinic per calendar day.';

create index if not exists idx_queue_live
  on queue_entries (clinic_id, queue_date, status, position)
  where removed_at is null;
