# Business Brain — History, Point-in-Time Knowledge and Provenance

> **The rule:** nothing OraMedha learns later may rewrite what it could have known
> earlier. Where the database cannot establish what was true at a moment, the
> answer is UNKNOWN, never a guess.

This document explains how that rule is kept. It covers event time versus record
time, observed versus reconstructed history, point-in-time reads, versioned
observations, outcome evidence, and what counts as training-safe. It also says
plainly what cannot be recovered.

Migrations: `20260917100000_entity_state_history.sql`,
`20260917100100_observation_provenance.sql`.

---

## 1. Two clocks

| | Meaning | Where it comes from |
|---|---|---|
| `recorded_at` | When OraMedha recorded the change | The database clock of the writing transaction. Never supplied by a caller. |
| `effective_at` | When the business event took effect | The record itself, with its **basis**. |

`effective_at_basis` says what the effective time rests on:

| Basis | Meaning |
|---|---|
| `recorded` | No separate event time is captured. The change is dated when it was recorded, and says so. |
| `performed_at` | A treatment's own `performed_at`. It may be backdated: performed Monday, keyed in Wednesday. |
| `payment_date` | The start of the payment's date in the clinic's timezone (date precision). |
| `unknown` | A migration baseline. What was found is known; when it came to be is not. |

**Recording time is the gate.** A change recorded after moment T does not exist
as far as T is concerned, whatever `effective_at` says. A payment keyed in on
5 September for 1 September is unknown as of 3 September. As of 6 September it
is known, and dated 1 September.

There is no bitemporal correction model. What OraMedha knows now about 3 September
is today's state, with each transition's effective date. Rewriting the past from a
later correction is exactly how later knowledge leaks into an earlier observation.

---

## 2. State history

Appointments, treatments, follow-ups, payments and patient records hold current
state only. Every change to the fields the Business Brain reads is now captured by
a trigger, in the same transaction, into an append-only version table:

| Table | Tracks |
|---|---|
| `appointment_status_history` | status, `scheduled_at`, duration, source, deletion |
| `treatment_status_history` | status, cost, `performed_at`, OPD/X-ray charges, deletion |
| `follow_up_status_history` | status, due date, deletion |
| `payment_state_history` | amount, payment date, deletion |
| `patient_state_history` | existence, deletion, payment plan (no name, contact or clinical field) |

Why triggers and not the existing audit trails: `appointment_history` and
`treatment_history` are written by some server actions, not all of them.
`checkInPatient` and `advanceQueue` change `appointments.status` without writing
`appointment_history`, and RLS sessions can update these tables directly. A trigger
captures every path: server actions, RPCs, cron jobs, direct client writes and the
service role.

### Observed, reconstructed, unknown

| Provenance | Meaning |
|---|---|
| `observed` | Captured by the trigger as the change happened. |
| `baseline` | The state found when capture began. Exact at its `recorded_at`; nothing before that moment is known. |
| `reconstructed` | Reserved for history rebuilt from other sources. **Nothing writes it.** The legacy audit trails are provably incomplete and are deliberately not imported. |

A point-in-time read returns one of three answers (`history/point-in-time.ts`):

- **known**: a version recorded by T gives the state.
- **absent**: the record's first version is its observed creation, recorded after T. It did not exist in OraMedha at T.
- **unknown**: nothing recorded by T, and nothing proves the record did not exist. Examples are a record that predates capture, or one with no history.

`entity_history_capture` records when capture began for each entity. A moment
before that cannot be answered from history.

### Immutability

- No role holds a write grant on the history tables, **including the service role**. Only the SECURITY DEFINER triggers write.
- UPDATE always raises.
- DELETE is refused except in two cases: a retention purge, or when the record (or its whole clinic) is removed by a non-client caller.
- A dentist's hard delete of a tracked row now fails. The old RLS DELETE policies still exist, and without this guard a hard delete would have erased the record's history with it.

---

## 3. Point-in-time reads

The database exposes readers that return, per record, the latest version
**recorded** at or before `p_known_at`:

- `appointment_states_as_of`
- `treatment_states_as_of`
- `follow_up_states_as_of`
- `payment_states_as_of`
- `patient_states_as_of`
- `action_result_events`: what followed an action, as observed transitions recorded in `[since, known_at]` and still standing at `known_at`

They are SECURITY INVOKER, so a dentist's session reads under RLS. Filters apply
**after** the latest version is chosen, so an old version can never match a window
the record has since left. All results are indexed and paged; nothing is sampled.

`SupabaseMetricsDataRepository` uses them whenever a snapshot describes a **past**
moment and history reaches back to it. Every snapshot carries its `knowledge`:

| Mode | When |
|---|---|
| `point_in_time` | Records read as known at `knownAt` |
| `current_state`, reason `describes_present` | The snapshot is of now |
| `current_state`, reason `before_history_capture` | History does not reach the moment. Current records are read, and every reading built on them says it was recomputed. |

---

## 4. Versioned observations

`metric_history` remains the current view the dashboard reads. Every write to it is
also appended to **`metric_observations`** by trigger, so an original measurement
stays identifiable forever.

| Provenance | Meaning |
|---|---|
| `observed_at_time` | Produced within 3 hours after the clinic-local day ended, from state as known at the end of that day |
| `point_in_time_reconstruction` | Produced later, from state as known at the end of that day, and from **no** unversioned input |
| `recomputed_later` | Anything else produced later: current state, or an unversioned input read today |
| `unknown` | Written before provenance existed (every pre-migration row) |

The current view keeps the better provenance. A lower-quality write is recorded in
`metric_observations` with `applied_to_current = false`, and never replaces what
was measured at the time. The database refuses provenance a writer cannot claim:

- an `observed_at_time` reading produced outside the grace window;
- a point-in-time reading that knows anything after its own day;
- a reading produced in the future.

Each reading also stores:

- `produced_at`: when it was computed.
- `knowledge_as_of`: the latest information it could use.
- `unversioned_inputs`: what it read that nothing versions.

**Unversioned inputs** (`provenance/metric-provenance.ts`, checked against what
every calculator actually reads):

| Input | Used by |
|---|---|
| `schedule_configuration` | Availability rules, consultation blocks, chair count, typical length. All `capacity.*` metrics. |
| `clinic_settings` | The recall interval. `patients.reactivation_candidates`. |
| `queue_entries` | Timestamped but mutable and retention-purged. Queue and overrun metrics. |

The clinic **timezone** defines the business day and is assumed fixed.

### Finding snapshots

A snapshot records `run_health`, `run_started_at` and `brain_version`. The database
refuses one whose run did not start on its business day, or that was written more
than two hours after its run started. A snapshot is what the run showed, and cannot
be regenerated later.

Rows from before this migration are `run_health = 'unknown'`. An **empty** unknown
snapshot may be a failed run rendered as a quiet briefing, so the learning read
treats that day as unknown.

### Memory builds

`clinic_memory_builds.knowledge_as_of` is the bound every evidence read used: the
end of `built_for`, or the build time if earlier. Decisions made after that moment
are not read. A rebuild for a past day gives the same memory whenever it runs.

---

## 5. Outcome evidence

| Source | Examples |
|---|---|
| `staff_declared` | "Mark as done" on a card. A follow-up closed with no attended visit on record. "Patient was called" (no delivery record exists). |
| `objectively_observed` | A payment row. A booking. A follow-up closed alongside an attended visit. Each captured when it was written. |
| `system_derived` | An inferred completion; a metric reading |
| `unknown` | A follow-up closure read from current rows, which cannot be corroborated |

`action_completions.completed_at` is the moment Done was **declared**. Nothing
records when the work was done (`CompletionTimeMeaning.DECLARATION_TIME`). A
declared completion cannot claim a moment after its own recording.

Every `Outcome` carries `evidenceQuality`: the completion's source and time
meaning, results split into objectively observed and not, how they were read, and
whether the upper rungs rested on point-in-time evidence.

### What the attribution ladder now requires

`likely_contributed` and `strong_evidence` additionally require:

- **`evidence_point_in_time`**:
  - every stored reading used (baseline, trend, horizon, clinic context) is `observed_at_time` or `point_in_time_reconstruction`;
  - and the targets' results were read from state history as known at the moment of assessment.
- **Only objectively observed results count** toward `targets_confirmed`, concentration and time-to-result. Staff-declared results are reported beside them as `declaredWithinWindow`, never added.

**OLD → NEW → WHY.**
- **Old:** a baseline recomputed weeks later from current records, and follow-up closures dated by `updated_at`, could lift an outcome to `likely_contributed`.
- **New:** they cap it at `observed_after`, and the requirement's detail says why.
- **Why:** that evidence used information unavailable at the time. Existing clinics regain the upper rungs as `observed_at_time` history and captured transitions accumulate after the migration: roughly a month for `likely_contributed`, two for `strong_evidence`.

---

## 6. Point-in-time learning

| Evidence | Temporal boundary |
|---|---|
| Completion | Read only if recorded by the read's `asOf` |
| Finding snapshot | Read only if recorded by `asOf`, and only from a healthy run or with findings on it |
| Snooze | `created_at` is stamped by the database for client writes, and read only if by `asOf` |
| Baseline before an action | Stored readings of point-in-time-safe provenance for the days before the completion |
| Result after an action | Transitions recorded in `[completed_at, asOf]`, dated by recording time, within the fixed horizon |
| Memory build | Everything bounded to the end of the built day, decisions included |

---

## 7. Training-data contract

`training/training-contract.ts` decides, deterministically, whether a stored
observation could ever train or evaluate a model. **There is no pipeline and no
model.**

**Valid** only when every condition holds:

- clinic-scoped;
- provenance known;
- produced `observed_at_time`, within the grace window, knowing nothing past its day;
- records read point-in-time;
- nothing withheld, truncated or missing;
- a label, when present, objectively observed, from a closed window;
- no patient-identifying field.

**Invalid** for each of: `clinic_mismatch`, `unknown_provenance`,
`future_leakage`, `recomputed_later`, `reconstructed_only`, `insufficient_data`,
`withheld_data`, `truncated_data`, `mutable_historical_state`,
`label_unavailable`, `label_staff_declared`, `outcome_window_open`,
`prohibited_identifier`. Every failed condition is returned, sorted.

---

## 8. What cannot be recovered

- **Any state before capture began.** Every transition before migration `20260917100000` is lost. For each existing row only the state at that moment is known (baseline). This includes:
  - when each existing appointment was cancelled or completed;
  - when each follow-up was closed;
  - when each treatment's status changed;
  - whether any payment or record was edited or deleted and restored.
- **Every `metric_history` row written before provenance existed.** Whether it was measured at the time or recomputed later cannot be told apart. All are `unknown`.
- **Whether any snapshot recorded before run health existed came from a healthy run.**
- **When an action was actually carried out, as opposed to declared.**
- **Whether a message was delivered or read.** No delivery record exists.
- **Past values of unversioned inputs:**
  - schedule rules, consultation blocks and chair count;
  - the recall interval;
  - queue entries, which are also retention-purged;
  - the clinic timezone.
- **Why a patient did not return.**
- **Changes made within the same transaction as a capture read.** `recorded_at` is the transaction's start. A long transaction that commits after T but started before T is invisible at T and dated before it.
