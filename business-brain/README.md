# Business Brain

The **Business Brain** is an independent application layer inside OraMedha. It
turns a clinic's own records into measurements, decides which of them are
unusual for that clinic, explains why, proposes work the clinic can actually do,
and measures what followed — with every statement traceable to evidence, and
nothing claimed that the records cannot support.

It is live behind a clinic allow-list (`BUSINESS_BRAIN_CLINIC_IDS` in
`lib/feature-flags.ts`) and renders at `/dentist/business-brain`.

> **What this module will not do:** invent a number, fill a gap with zero, or say
> the clinic caused an improvement. Where the records cannot answer, the answer
> is "unknown", and the UI says so.

---

## The run

One run per clinic-day. Five recorded stages, each stopping the ones after it if
it fails:

```
Metrics ─▶ Signals ─▶ Diagnosis ─▶ Strategy ─▶ Actions
```

| Stage | Question | Where |
|---|---|---|
| Metrics | What are the numbers? | `engines/metrics/` |
| Signals | Which of them are unusual for THIS clinic? | `engines/signals/` |
| Diagnosis | Why? Which hypotheses survive the evidence? | `engines/diagnosis/` |
| Strategy | What is worth doing, given the clinic's limits? | `engines/constraint/`, `engines/value/`, `engines/strategy/`, `engines/workflow/` |
| Actions | What can OraMedha prepare? | `engines/action/` |

Derived outputs are computed alongside the run and never feed a later stage, so
a failure in one cannot silently change another: **baselines** (this clinic's
normal range), **achievements** (measured improvements), **trajectories**,
**opportunities**, **root causes** (only when a finding qualifies) and the
**findings** projection that ranks everything for the page.

After the fact, three engines close the loop: **outcome** (what followed a
completed action), **learning** (what has worked repeatedly) and **memory**
(what is worth remembering about this clinic, rebuilt each day).

`services/business-brain-service.ts` orchestrates all of it and reports run
health. `assessRunHealth` is what makes a failed run show as "unavailable"
rather than as a quiet clinic.

---

## Layout

```
business-brain/
├── README.md               # this document
├── HISTORY.md              # point-in-time knowledge, provenance, attribution
├── METRICS-REVIEW.md       # the metric catalogue, reviewed
├── index.ts                # public barrel — import from "@/business-brain"
├── types/                  # EngineResult, ExecutionContext, Evidence, Confidence…
├── domain/                 # Metric, Signal, Diagnosis, Constraint, Strategy,
│                           # Workflow, Action, Outcome, Learning, Achievement, Memory
├── core/                   # the Engine contract and BaseEngine
├── engines/                # the implementations (below)
├── ledger/                 # relational facts, the graph over them, and
│                           # record-evidence.ts — what a row may be read as
├── repositories/           # ports: ClinicDataSnapshot and the data contracts
├── history/                # point-in-time readers and coverage
├── provenance/             # how a stored reading was produced, and evidence quality
├── memory/                 # the memory engine and its reader
├── training/               # what may be used to train a model (there is no model)
├── services/               # BusinessBrain — the run, and its health
├── validation/             # Zod helpers
└── utils/                  # dates, logger
```

The Supabase adapters live outside this module, in `lib/business-brain/`:
`metrics-repository.ts`, `clinic-ledger.ts`, `diagnosis-context.ts`,
`metric-history-store.ts`, `clinic-memory.ts`, `finding-snapshots.ts`,
`paged-read.ts`, and the view projections the page renders
(`briefing-view.ts`, `wins-view.ts`, `outcomes-view.ts`, `clinic-health.ts`).

### Engines

| Engine | Responsibility |
|---|---|
| `metrics` | 32 KPIs from one clinic-day snapshot. Withheld when unmeasurable, never zeroed. |
| `signals` | 31 signal types, thresholds calibrated per clinic. |
| `diagnosis` | 17 matchers across acquisition, clinical, financial, operational, retention and scheduling, each with hypotheses and discriminators. |
| `constraint` | Groups diagnoses into the 10 constraint categories the clinic recognises. |
| `value` | What is at stake behind each constraint, in rupees or patients. |
| `strategy` | Constraint-valid approaches. |
| `workflow` | An ordered, doable decomposition of a strategy. |
| `action` | Prepared work: filtered screens, drafted messages, pre-filled forms. **It prepares; it never performs.** |
| `baseline` | This clinic's own normal range per metric, with a quality rating. |
| `achievement` | Measured improvements against that normal — the wins strip. |
| `trajectory` | Where a metric has been heading, and for how long. |
| `opportunity` | Time still ahead that could be filled. |
| `root-cause` | Where a problem concentrates, with real significance testing. |
| `findings` | One ranked, explained list out of everything above. |
| `outcome` | What the clinic's own records show after a completed action. |
| `learning` | What has worked for this clinic, repeatedly, and what has not. |

`engines/ai-explanation-engine.ts` is a **contract with no implementation**:
the verifier (`verifyExplanation`) and its prompt exist and are used as the
pattern for `summarizeDashboardActions`, but nothing in the Business Brain calls
a model today. Building the explanation surface means implementing this engine —
not adding an ungated model call somewhere else.

---

## Rules that hold everywhere

- **The UI depends on the Business Brain, never the reverse.** No engine imports
  React or an OraMedha component. An eslint boundary over `engines/action/**`
  fails the build if a network client, database client or model is imported there.
- **Engines are pure.** Data in, decisions out: no clock, no I/O, no randomness.
  `now` and `date` are always supplied by the caller.
- **Errors are values.** Engines return `EngineError` inside `EngineResult`
  rather than throwing across boundaries.
- **One direction:** `types → core → domain → engines → services`, with
  `repositories`, `ledger` and `history` feeding services.

---

## Production invariants

Each is pinned by the test named with it; a change that breaks one should break
that test first.

**Reads are whole, or they say so.** PostgREST silently caps a response at 1000
rows. Every multi-row read in `lib/business-brain/` pages through
`paged-read.ts`: `readAll` returns everything or throws `BoundedReadError`,
`readUpTo` reports truncation the engines treat as a gap, and a window too large
to read whole is refused rather than sampled. `paged-read.spec.ts`,
`bounded-reads.spec.ts`.

**A failed run is never a quiet clinic.** Empty output from a failed run reads
exactly like a healthy clinic with nothing wrong. Every surface calls
`assessRunHealth` first and shows "unavailable" instead; a finding snapshot is
recorded only for a healthy run.

**Dates are the clinic's, not the server's.** Business dates, hours and ages are
clinic-local (`clinic_settings.timezone`), never `iso.slice(0, 10)` of a UTC
instant. `local-dates.spec.ts` covers midnight, DST, month and year ends.

**A concentration must beat chance across every comparison made.** Root causes
use a one-sided Fisher exact test for rates and a rank-sum test for minutes,
against a 5% family budget divided across the groups compared, on top of
effect-size rules. `false-positives.spec.ts` runs 1000 seeded clinics with
nothing to find and holds each analysis at or under 6%.

**The server writes evidence; the browser does not.** `action_completions` and
`clinic_decisions` have no client INSERT; the server validates the card and
writes with the service role, idempotently. `rls-matrix.spec.ts` checks every
Business Brain table against every role.

**Memory is reproducible and fresh.** A build for a past day reads evidence as of
the end of that day, so rebuilding later gives the same digest. Findings cite
memory only from a build at most two days old.

**Nothing is read as more than it is.** `ledger/record-evidence.ts` states, once,
how to read a record whose click and whose event differ: an inferred no-show is
not an observed one, a visit clicked through in under a minute records no
arrival, a visit left open after its day has no outcome, a completed treatment
with no `performed_at` is dated by when its completion was recorded and says so,
and a consultation charge is not a treatment type.

### History, provenance and what the past knew

See **[HISTORY.md](./HISTORY.md)**. In short: every change to appointments,
treatments, follow-ups, payments and patients is captured by trigger into
append-only state versions with a database-stamped `recorded_at`; stored readings
carry typed provenance, and a recomputation never replaces one measured at the
time; the upper attribution rungs require point-in-time readings and objectively
observed results; `training/training-contract.ts` defines training-safe data, and
there is no model.

### What the database cannot tell us

- Anything before history capture began (HISTORY.md §8).
- Whether a message was delivered or read. Outreach is a declaration, not an
  observed contact.
- When an action was actually done: `completed_at` is when it was declared.
- Why a patient did not return — only that no later visit is recorded.
- Anything about a day with no snapshot.

### Recording gaps

Every "we could not tell you" traces back to something nobody pressed — a visit
with no check-in has no measurable wait, a treatment with no `performed_at` is
dated by when it was typed, a no-show the nightly job inferred is a reading
rather than an observation. `business-brain/ledger/record-quality.ts` counts
those gaps, `lib/business-brain/record-quality.ts` reads them, and the briefing
shows each beside the measurement it costs and the screen that closes it.

It is not a compliance score: no target, no grade, no comparison between
clinics. A clinic that never uses the queue board is making a legitimate choice,
and this says what the choice costs.

### Known limits, not fixed here

- The briefing runs the whole pipeline on every page load, including the history
  the run measures for itself. It should be precomputed by the scheduled job.
- Both attendance rates go unjudged until six days of denominator have been
  recorded: stored history predates `scheduling.appointments_30d`, and those days'
  denominators are genuinely unknown.
- `revenue.collection_rate_30d` is kept as a cash-flow ratio and is no longer
  judged or scored. Every judgement now reads
  `revenue.production_paid_rate_30d`, which follows the work.
- The unpaid share of a window's work is attributed by the patient's own
  surviving balance, capped at what the window charged. No payment is matched to
  a treatment anywhere in OraMedha, so the oldest-charge-first convention is an
  assumption — a stated one, and the cap keeps older debt out either way.
- Seasonality is implemented and DORMANT: a band is drawn from the same weeks of
  earlier years only once the history spans 330 days, and no clinic has that.
  `BaselineResult.seasonality` states so on every run rather than leaving it to
  be assumed.
- Weekday bands need six of the same weekday, so they start after six weeks of
  recorded days and apply only to metrics that describe ONE day.
- Shared core queries the briefing relies on (`getOverdueFollowUps`,
  planned-without-visit, the `clinic_outstanding_balances` RPC) are not paged.
- No retention purge covers `finding_snapshots`, `clinic_memory_builds`,
  `action_completions`, `metric_observations` or the state-history tables.
- `getClinicConfig` falls back to defaults when `clinic_settings` cannot be read,
  app-wide; this module's own repository throws instead.

### Operations

The hourly job (`/api/cron/metric-history`, scheduled by pg_cron in migration
`20260731000100`) records each clinic's completed day and builds its memory. It
reads its URL and bearer token from Vault (`app_base_url`, `cron_secret`).
**If that URL is wrong, every call fails silently** — pg_cron reports success for
a request it merely queued. That happened between the Vercel project rename and
18 Sep 2026, and it left the hosted project with no reading recorded at the time
and no memory build at all. `/admin` now shows each job's health, and
`lib/business-brain/job-health.ts` is what it reads.
