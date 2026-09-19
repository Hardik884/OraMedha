# Retention and deletion

**How long OraMedha keeps things, why, and what it deliberately never deletes.**

---

## 1. The line

**Clinical and audit records are never purged on a timer.**

`patients`, `appointments`, `treatments`, `payments`, `follow_ups`, `consents`,
`patient_teeth`, `tooth_history`, `appointment_history`, `consent_audit`,
`treatment_history` and `data_consent_records` are absent from
`retention_policies` and **unreachable** from `run_retention_purge`.

So are the **state-history** tables — `appointment_status_history`,
`treatment_status_history`, `follow_up_status_history`, `payment_state_history`
and `patient_state_history`. They sit with the clinical records rather than with
the logs because they are what "what was known at T" is reconstructed from:
purging one would not shrink a log, it would quietly change the answer to a
question about the past, and the answers would keep being produced from what
survived.

That is structural, not a convention. The function switches on an **explicit
CASE** over a fixed set of operational tables, so adding a policy row cannot by
itself cause a table to be deleted from; dynamic SQL would have moved that
decision into data, where nobody reviews it.
`lib/__tests__/retention-scope.spec.ts` parses the migration and fails if the
function ever gains a `DELETE` against a clinical table, or gains dynamic
execution.

Three reasons, and none of them is squeamishness:

1. A clinic's record-keeping duties are measured in years and set by its
   regulator, not by this schema.
2. An audit trail exists precisely to outlive the thing it describes.
3. A generic timer firing on a clinical table destroys evidence quietly, at
   scale, and is discovered afterwards.

Whatever the clinical retention period turns out to be, it will be applied by a
deliberate, reviewed, per-clinic process — not by this cron job.

---

## 2. Product defaults ≠ legal requirements

Every period below is an **engineering judgement** about how long operational
data stays useful. None is a legal position. `retention_policies` carries a
`legally_confirmed` column — **`false` on every row** — so the distinction
survives contact with the next reader instead of living in a comment elsewhere.

⚖️ **REQUIRES LEGAL CONFIRMATION** before any of these is relied on as
compliance with anything.

| Key | Default | Why this number |
|---|---:|---|
| `queue_entries_completed` | 90 d | The queue resets daily. A completed entry from last quarter tells nobody anything, and the row records that a named patient was physically present at a clinic on a date. |
| `reminder_logs` | 365 d | Exists only to suppress duplicate messages, so its usefulness expires with the reminder. `kind` leaks clinical context (`payment_reminder`, `recall_invitation`) for as long as the row survives. |
| `webhook_logs` | 90 d | Debugging material. Nothing has ever written to this table — the policy is pre-emptive. |
| `metric_history` | 1095 d | Aggregates with no patient identifier. Long because trend analysis is the point, and three years is two full year-on-year comparisons. |
| `problem_dismissals` | 90 d | Snoozes carry their own `expires_at`; this clears rows once the snooze is long past. |
| `phi_access_log` | 730 d | A security log. The window is how far back an investigation might reasonably reach — comfortably beyond the 180 days the Indian log-retention direction asks for. Shortening it makes a future breach harder to scope, which is the situation it exists for. |
| `deleted_treatment_documents` | 90 d | Grace period so a radiograph removed by mistake can be restored. After it, row **and** storage object are cleared. |
| `metric_observations` | 365 d | Every *version* of every metric reading, including recomputations that never replaced the current row — the fastest-growing table in the schema at ~35 rows per clinic per day before rewrites. Point-in-time reads reach back weeks, and `metric_history` keeps the standing value. |
| `finding_snapshots` | 365 d | What the briefing showed, one row per clinic-day. The Learning Engine reads recent weeks; beyond a year the rules themselves have changed enough that the comparison stops meaning anything. |
| `clinic_memory_builds` | 180 d | Derived memory, rebuilt daily from evidence that is still there. Purging it loses nothing that cannot be recomputed. |
| `action_completions` | 730 d | What a clinic did about a finding. Read by the Outcome Engine within three weeks and by the Learning Engine over a longer span; that history is what distinguishes a clinic that acts from one that does not. |
| `finding_feedback` | 730 d | Verdicts on findings. A rule's precision is measured across clinics and releases, and a short window would keep resetting the count. |
| `job_runs` | 90 d | One row per scheduled-job run, hourly. Only the latest run of each job is read; the rest is a trail for looking back at an incident. |

---

## 3. Deletion, as it actually works

### A patient is soft-deleted

`softDeletePatient` (dentist only) marks `deleted_at` on the patient and
cascades to appointments, treatments, payments, follow-ups, **the dental
chart, treatment documents and consents**, removes reminder records and active
queue entries outright, and unlinks the portal account.

The three clinical cascades are **soft**: the clinic still has record-keeping
duties, and a consent is the proof that a treatment was authorised. Nothing is
physically removed.

`actions/__tests__/patient-cascade-completeness.spec.ts` reads the migrations,
finds every table with a foreign key to `patients`, and fails unless the cascade
handles it or the spec records in writing why not — because the way a cascade
stops being complete is a table added months later by someone who never read it.

### A document is removed

An `UPDATE` setting `deleted_at` and `deleted_by`. The RLS `DELETE` policy was
dropped, so the hard route is closed rather than merely unused. The storage
object is cleared by the retention job after the grace period.

### An audit row is removed

Only by `run_retention_purge`, which declares `app.purge_context = 'retention'`
for the duration of its transaction. The append-only triggers check for exactly
that, and they bind the service role too.

---

## 4. Running the purge

```
POST /api/cron/retention-purge
Authorization: Bearer $CRON_SECRET
Content-Type: application/json

{"dryRun": true}
```

**Dry run is the default.** An empty body, a malformed body, the string
`"false"`, a missing field — all count and delete nothing. Only an explicit
boolean `false` purges.

The response reports, per policy, the cutoff and the number of rows affected
(or that *would* be affected).

### ⚙️ REQUIRES MANUAL CONFIGURATION — the sequence

1. Run with `{"dryRun": true}` against production. **Read the counts.**
2. Sanity-check every number. A surprising count means a wrong period, and the
   dry run is where that gets caught rather than after the rows are gone.
3. Adjust `retention_policies` via a migration if needed, and re-run the dry run.
4. Run once with `{"dryRun": false}` and check the report.
5. Only then schedule it — weekly is ample; nothing here is time-critical.

The other two cron jobs are scheduled from their migrations because they are
additive. This one deletes, and it is deliberately **not** scheduled by
`20260903000500`: turning it on before someone has read a dry run means the
first evidence of a wrong number is missing rows.

### Job properties

- **Idempotent.** The window is computed from `now()` and the `WHERE` clause is
  the whole condition, so running twice removes nothing extra.
- **Safe to retry.** A failed run deleted a prefix of what it would have; the
  next continues.
- **Bounded.** Document clearing is capped per run, so one run cannot hold a
  lock indefinitely.
- **Object before row.** A crash between them orphans a file the next run cannot
  find — bounded and acceptable. The reverse order would leave a live radiograph
  on disk with nothing pointing at it, permanently.

---

## 5. Not implemented

- **No per-clinic retention overrides.** `retention_policies` is platform-wide.
  Adding a nullable `clinic_id` is the natural extension.
- **No automatic clinical-record retention.** Deliberate — see §1.
- **No anonymisation-in-place.** A soft-deleted patient's row still holds their
  name and phone. Anonymising rather than retaining is the right long-term
  answer for a record past its retention period, and it needs the clinical
  period settled first.
