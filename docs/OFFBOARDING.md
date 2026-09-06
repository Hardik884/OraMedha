# Clinic offboarding

**Status: DESIGN ONLY. Nothing described here is implemented, and that is the
recommendation, not an omission.**

This document exists because P1 verification found that deleting a clinic fails
once audit records exist for it. The reflex is to treat that as a bug and make
deletion work. This is the argument for why it is not a bug, what the correct
lifecycle looks like, and what should actually be built — which is very little,
and not yet.

---

## 1. What the product does today

**There is no clinic-deletion feature.** Not a disabled one, not a hidden one —
none. Searching the repository for a delete against `clinics` returns test
cleanup and nothing else:

```
actions/__tests__/billing-charges.spec.ts
actions/__tests__/follow-up-overdue.spec.ts
actions/__tests__/patient-appointments-for-treatment.spec.ts
actions/__tests__/reminder-population.spec.ts
app/api/cron/no-show-detection/__tests__/route.spec.ts
```

Consistent with that, `clinics` carries exactly one RLS policy:

| Policy | Command |
|---|---|
| `clinics: staff can read own clinic` | SELECT |

No INSERT, no UPDATE, no DELETE, for any role. Under RLS the absence of a policy
is a denial, so no client can create, rename or remove a clinic. Clinics are
created by migration (`20260627000000`).

So "clinic deletion fails" is not a broken feature. It is a `DELETE` nobody can
issue except someone holding the service role or a direct database connection.

---

## 2. Exactly why it fails

Reproduced against a local database, as `postgres` (RLS bypassed entirely):

```sql
insert into clinics  (id, name) values ('…dead', 'Offboarding Probe');
insert into patients (id, clinic_id, name) values ('…bee1', '…dead', 'Probe Patient');
insert into phi_access_log (clinic_id, patient_id, actor_role, event, resource_type)
  values ('…dead', '…bee1', 'dentist', 'PATIENT_VIEWED', 'patient_record');

delete from clinics where id = '…dead';
```

```
ERROR:  phi_access_log rows may only be deleted by the retention purge
CONTEXT: PL/pgSQL function phi_access_log_is_append_only() line 11 at RAISE
SQL statement "DELETE FROM ONLY "public"."phi_access_log" WHERE $1 = "clinic_id""
```

The mechanism, in order:

1. Every tenant-scoped table declares `clinic_id … references clinics(id) **on
   delete cascade**`.
2. Deleting a clinic therefore issues a `DELETE` against each child table.
3. Four of those tables carry a `BEFORE DELETE` trigger that refuses unless the
   transaction has set `app.purge_context = 'retention'`:

   - `phi_access_log`
   - `data_consent_records`
   - `data_consent_notices`
   - `treatment_history`

4. The trigger raises, the cascade aborts, the whole transaction rolls back.

**The trigger binds the service role too.** `service_role` carries `BYPASSRLS`,
so no policy could constrain it; the trigger is the layer that can, and that is
why it is a trigger rather than a policy. Nothing short of dropping the trigger
gets past it.

**This is the system working.** Those four tables are the ones whose entire
purpose is to outlive what they describe — who read a patient's record, what a
person was shown when they consented, what changed on a clinical note. A cascade
that erased them on the way to removing a clinic row would destroy exactly the
evidence that exists to answer questions asked *after* a relationship ends. The
error is the design asserting itself.

---

## 3. Why this is a lifecycle problem, not a deletion problem

A clinic leaving is not one event. It is a sequence, and the sequence matters
because the obligations at each stage are different and some of them outlast the
commercial relationship by years.

```
ACTIVE
  ↓            the clinic is using the product
OFFBOARDING
  ↓            departure agreed; data export produced; nothing deleted
ACCESS DISABLED
  ↓            staff can no longer sign in; the tenant still exists
NO NEW OPERATIONS
  ↓            no bookings, no treatments, no messages; reads still resolve
RETENTION PERIOD
  ↓            clinical + audit records held for their statutory life
PERMITTED DATA DISPOSITION
               only what is eligible, only when eligible
```

The two stages people conflate are the last two. "Delete the clinic" usually
means *ACCESS DISABLED* — stop the staff signing in, stop the bill. It almost
never means *DISPOSITION*, which is constrained by:

- **Dental record retention.** A clinic's obligation to keep a patient's
  clinical record does not end when the clinic stops paying for software. The
  applicable period is a question for the clinic's own advisor, not for this
  document — see §5.
- **Consent evidence.** `data_consent_records` answers "was this processing
  lawful at the time". That question is asked after the fact by definition, and
  most often precisely when a relationship has gone wrong.
- **Access evidence.** `phi_access_log` answers "who read this record". Deleting
  it on offboarding means the last people who could be asked about a suspected
  breach lose the only record of it.

A patient's clinical record is *the patient's* history. The clinic ending its
subscription is not the patient's decision and should not silently destroy it.

---

## 4. What should be built, and when

**Recommendation: build nothing yet.** Three reasons, in order of weight.

1. **The dangerous end is already closed.** No client path can delete a clinic,
   and the service role cannot either while the triggers stand. Whatever is
   built later starts from a safe position; there is no window to close.
2. **The needed capability today is one SQL statement, not a subsystem.** What
   an offboarding clinic actually needs first is *ACCESS DISABLED*, and that is
   achieved by disabling the staff accounts in Supabase Auth. No schema change,
   no new state machine, no new surface.
3. **A lifecycle built before the first real offboarding would encode guesses.**
   OraMedha has not offboarded a clinic. The retention period is not settled
   (§5). Building a `clinic_status` enum and a set of transitions now means
   choosing those answers by implication, in code, and then living with them.

### When it *is* worth building

The trigger is a **second** clinic leaving, or the first one where the
disable-the-accounts approach proves insufficient. At that point the minimal
honest implementation is:

- `clinics.status` — `active` | `offboarding` | `closed`, defaulting to
  `active`, plus `offboarded_at`.
- Server actions refuse writes when status is not `active`. Reads keep working;
  a closed clinic's records must stay readable for an authorised export.
- **No cascade change. No trigger change. No FK change.** Disposition, if it
  ever happens, goes through the existing `run_retention_purge` mechanism —
  which already knows how to declare `app.purge_context` and is already the one
  path the triggers permit.

That last point is the constraint to carry forward: **the purge is the only
legitimate deletion route, and any offboarding work must go through it rather
than around it.** Making the FKs `on delete restrict`, dropping a trigger, or
adding a "force delete" would each solve the immediate error by removing the
protection it exists to provide.

---

## 5. What must be decided by a person, not inferred from code

⚙️ **REQUIRES A DECISION** — clinical-record retention period. `docs/RETENTION.md`
sets periods for operational data (`reminder_logs` 365 days, `webhook_logs` 90,
completed `queue_entries` 90). It sets none for the clinical record itself,
because that is a regulatory and professional question for the clinic's advisor.
Until it is answered, no disposition step can be built, and building one would
mean inventing the number.

⚙️ **REQUIRES A DECISION** — who holds the record after a clinic leaves. The
clinic is the entity with the retention obligation to its patients; OraMedha
holds the data on its behalf. Whether departure means "export and hand over" or
"OraMedha continues to hold it" is a contractual question, and it determines
whether disposition is ever OraMedha's action to take at all.

⚙️ **REQUIRES A DECISION** — what the clinic receives on the way out.
`actions/data-export.ts` exports a single patient's record. There is no
clinic-wide export. A clinic that cannot take its records with it cannot leave
properly, so this is the one piece of *product* work offboarding plausibly needs
— and it is additive, safe, and destroys nothing.

---

## 6. Related

- `docs/RETENTION.md` — what is purged on a timer, and what never is
- `docs/DATA-PROTECTION.md` — roles, consent, patient rights
- `supabase/migrations/20260903000500_retention_policies.sql` — `run_retention_purge`,
  the only sanctioned deletion path
- `actions/__tests__/patient-cascade-completeness.spec.ts` — the equivalent
  problem one level down, already solved for *patient* deletion
