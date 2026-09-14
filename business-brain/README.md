# Business Brain

The **Business Brain** is an independent application layer inside DentGrow
responsible for business intelligence and decision making. It turns raw clinic
data into metrics, detects meaningful signals, diagnoses root causes, proposes
constraint-valid strategies, executes and measures actions, and learns from the
results — with every decision explainable to clinic staff.

> **Phase 1 of 22 — Foundation only.**
> This phase establishes the architecture. It contains **no business logic**.
> Every engine is a documented contract that future phases implement.

---

## Purpose

- Keep business intelligence and decision logic **out of React components**.
- Give the UI a single, stable place to consume decisions and explanations.
- Let each concern evolve independently behind a small, typed contract.
- Make future phases additive — new engines slot in without refactoring the
  foundation.

---

## Architecture

The Business Brain is a pipeline of loosely coupled, single-responsibility
engines. Each engine takes a typed input plus an `ExecutionContext` and returns
a uniform `EngineResult<T>`.

```
Metrics ─▶ Signal ─▶ Diagnosis ─▶ Constraint ─▶ Strategy ─▶ Workflow ─▶ Action
                                                                          │
                                                                          ▼
                                        Learning ◀─ Value ◀─ Outcome ◀────┘

                 AIExplanation  (explains outputs & decision traces across the pipeline)
```

The chain answers one question per stage:

| Stage | Question |
| --- | --- |
| Metrics | What are the numbers? |
| Signal | Which of them are unusual? |
| Diagnosis | Why? |
| Constraint | Which of those are the same problem? |
| Value | How much is sitting in each? |
| Strategy | What should be done? |
| Workflow | How should the clinic approach it? |
| Action | How can DentGrow help execute it? |

The Action Engine is the last deterministic stage. It converts each workflow into
prepared work — screens to open already filtered, message drafts to reuse, forms
to fill — and performs none of it. Nothing in it sends, writes, schedules or calls
an API, and the `eslint` boundary over `engines/action/**` fails the build if a
network client, database client or model is imported there.

Principles enforced by this structure:

- **UI depends on the Business Brain; never the reverse.** No engine imports
  React or any DentGrow component.
- **Single responsibility per engine.**
- **Loose coupling** — engines communicate through shared primitive types, not
  by importing each other's internals.
- **No circular dependencies** — dependency direction is one-way:
  `types → core → engines → services`, with `repositories` feeding services.
- **Strong typing throughout** and **composition over inheritance**.
- **Errors as values** — engines return `EngineError` inside `EngineResult`
  rather than throwing across boundaries.

---

## Folder Structure

```
business-brain/
├── README.md              # This document
├── index.ts               # Public API barrel (import from "@/business-brain")
├── types/                 # Shared, generic primitive types
│   ├── common.ts          # EngineResult, ExecutionContext, Evidence, Confidence,
│   │                      # Priority, Severity, DecisionTrace, EngineError
│   └── index.ts
├── domain/                # Canonical domain models (the Business Brain's vocabulary)
│   ├── shared.ts          # EntityType, RelatedEntity
│   ├── metric.ts          # Metric, MetricCategory, MetricUnit
│   ├── signal.ts          # Signal, SignalCategory
│   ├── diagnosis.ts       # Diagnosis
│   ├── constraint.ts      # Constraint, ConstraintCategory
│   ├── strategy.ts        # Strategy
│   ├── value.ts           # Value, ValueType
│   ├── workflow.ts        # Workflow, WorkflowTask, WorkflowOwner/Effort/Timeframe
│   ├── action.ts          # Action, ActionPlan, ActionKind/Category/Readiness,
│   │                      # DentGrowArea, ActionChannel, ActionExecution
│   ├── outcome.ts         # Outcome, OutcomeStatus
│   ├── learning.ts        # Learning
│   └── index.ts
├── core/                  # Foundational contracts everything depends on
│   ├── engine.ts          # Engine interface + BaseEngine abstract class
│   └── index.ts
├── engines/               # One contract per engine (abstract class + I/O types)
│   ├── metrics-engine.ts
│   ├── signal-engine.ts
│   ├── diagnosis-engine.ts
│   ├── constraint-engine.ts
│   ├── strategy-engine.ts
│   ├── workflow-engine.ts
│   ├── outcome-engine.ts
│   ├── value-engine.ts
│   ├── learning-engine.ts
│   ├── ai-explanation-engine.ts
│   ├── metrics/           # MetricsEngine implementation (Phase 3)
│   │   ├── metric-ids.ts          # metric keys, descriptors, buildMetric factory
│   │   ├── calculators/           # one pure function per metric group
│   │   └── metrics-engine.ts      # DentGrowMetricsEngine (deterministic)
│   ├── workflow/          # WorkflowEngine implementation
│   │   └── workflow-engine.ts     # templates + WORKFLOW_TEMPLATE_KEYS
│   ├── action/            # ActionEngine implementation (deterministic, side-effect free)
│   │   ├── action-catalog.ts      # every capability DentGrow can prepare, defined once
│   │   ├── action-plans.ts        # workflow template key → ordered capabilities
│   │   ├── action-dates.ts        # the date windows every filter is built from
│   │   └── action-engine.ts       # generateActions(workflows, clinic, date, now)
│   └── index.ts
├── config/                # Feature flags, engine toggles, thresholds, AI placeholder
│   ├── config.ts
│   └── index.ts
├── validation/            # Reusable Zod-based validation utilities
│   ├── validators.ts
│   └── index.ts
├── utils/                 # Cross-cutting utilities
│   ├── logger.ts          # Centralized info/warn/error logger
│   └── index.ts
├── services/              # (reserved) Cross-engine orchestration — future phases
│   └── index.ts
└── repositories/          # Read-only data ports (no DB access here yet)
    ├── snapshots.ts       # ClinicDataSnapshot + sub-snapshot shapes
    ├── metrics-data-repository.ts  # MetricsDataRepository port (impl: future phase)
    └── index.ts
```

---

## Module Responsibilities

| Module | Responsibility |
|---|---|
| `types/` | Generic primitives shared by all engines. No business objects. |
| `core/` | The `Engine` contract and `BaseEngine`. Depends only on `types`. |
| `engines/` | A documented contract (abstract class + placeholder I/O types) for each of the 11 engines. |
| `config/` | Lightweight static config: feature flags, per-engine toggles, thresholds, AI placeholder. |
| `validation/` | Reusable input-validation helpers built on Zod. |
| `utils/` | Cross-cutting helpers, currently the centralized logger. |
| `services/` | Orchestrates the engines into one run (`BusinessBrain`) and reports its health (`assessRunHealth`). |
| `repositories/` | Port types only. The Supabase adapters live in `lib/business-brain/`. |

### The 11 Engines

| Engine | Responsibility |
|---|---|
| `MetricsEngine` | Compute the clinic's core KPIs from raw data. |
| `SignalEngine` | Detect anomalies/patterns in metrics and emit prioritized signals. |
| `DiagnosisEngine` | Explain *why* signals occur via root-cause diagnoses. |
| `ConstraintEngine` | Encode/evaluate real-world limits (capacity, budget, policy). |
| `StrategyEngine` | Propose constraint-valid strategies for diagnoses. |
| `WorkflowEngine` | Decompose a strategy into an ordered, executable workflow. |
| `ActionEngine` | Convert a workflow into work DentGrow has already prepared: filtered screens, message drafts, pre-opened forms. It prepares; it never performs. |
| `OutcomeEngine` | Measure actual results vs. expectations after actions. |
| `ValueEngine` | Quantify the business value delivered by outcomes. |
| `LearningEngine` | Feed outcomes/value back to improve future decisions. |
| `AIExplanationEngine` | Turn outputs & decision traces into human-readable explanations. |

---

## How Future Phases Build on This Foundation

Each subsequent phase implements one engine (or supporting layer) **without
touching the foundation**:

1. Add the engine's concrete input/output types (replacing the `unknown`
   placeholders) next to its contract in `engines/`.
2. Extend the engine's abstract class and implement `execute()`.
3. Add any needed data access as a method in `repositories/`.
4. Add orchestration (multi-engine pipelines) in `services/`.
5. Opt the engine in via `config` (`engines.<name> = true`).
6. Expose results to the UI through the `@/business-brain` public barrel and,
   where mutations are involved, DentGrow's existing Server Actions.

Because engines share only generic primitive types and a uniform result
envelope, new engines integrate without breaking existing ones.

---

## Integration with DentGrow

- **Import path:** consumers use `@/business-brain` (matches the project's
  `@/*` path alias). Only the public barrel is imported — internal files are
  not reached across the boundary.
- **One-way dependency:** DentGrow (Server Components, Server Actions, UI)
  depends on the Business Brain. The Business Brain never imports React or
  DentGrow components, keeping business logic testable and UI-independent.
- **Data & side effects:** in later phases, engines read data through
  `repositories/` and cause side effects through DentGrow's existing
  `actions/` — the Business Brain consumes those, it does not own the data.
- **AI:** the `AIExplanationEngine` will wire up to the existing `lib/ai`
  (Gemini) layer in a future phase. Only a config placeholder exists now.

---

## Production Invariants

These hold across every engine and adapter. Each is pinned by a test named here;
a change that breaks one should break that test first.

**Reads are whole, or they say so.** PostgREST returns at most `max_rows` (1000)
rows however large a `.limit()` asks for, silently. Every multi-row read in
`lib/business-brain/` pages with `.range()` over a total order through
`paged-read.ts`: `readAll` returns everything or throws `BoundedReadError`;
`readUpTo` returns a limit plus a `truncated` flag the engines report as a gap. A
window too large to read whole is refused (`EntityWindowTooLargeError`), never
sampled. `paged-read.spec.ts` forbids a bare `.limit(n > 1)` in these files;
`bounded-reads.spec.ts` proves it on more than 1000 real rows.

**A failed run is never a quiet clinic.** Empty outputs from a failed run read
exactly like a clinic with nothing wrong. The briefing page, the compact card and
the proposal decision all call `assessRunHealth` first and show "unavailable"
instead; a finding snapshot is recorded only for a healthy run.

**Dates are the clinic's, not the server's.** Business dates, hours and ages are
clinic-local (`clinic_settings.timezone`), via `localDatePart` and the metric id's
own date — never `iso.slice(0, 10)` of a UTC instant. `local-dates.spec.ts`
covers midnight, DST, month and year ends.

**A concentration must beat chance across every comparison made.** Root causes
test rates with a one-sided Fisher exact test and minutes with a rank-sum test,
each against a 5% family budget divided across the groups compared (Bonferroni),
on top of the effect-size rules. `false-positives.spec.ts` runs 1000 seeded
clinics with nothing to find per analysis and holds each at or under 6%.

**The server writes evidence; the browser does not.** `action_completions` and
`clinic_decisions` have no client INSERT. The server validates the card
(`completion-card.ts`: this clinic, this category, the last week) and writes with
the service role, idempotently per card; database checks pin the constraint id
and a decision's target to the row's clinic and keep a decision's basis to codes
and numbers. Duplicate completions of one card count once (`dedupeCompletions`).
`rls-matrix.spec.ts` checks every Business Brain table against every role.

**Memory is reproducible and fresh.** A build for a past day reads evidence as of
the end of that day, so rebuilding later gives the same digest. Findings cite
memory only from a build at most two days old.

### History, provenance and what the past knew

See **[HISTORY.md](./HISTORY.md)**. In short:

- **Every change is captured.** Changes to appointments, treatments, follow-ups, payments and patient records are captured by trigger into append-only state versions, with a database-stamped `recorded_at`. Past moments are read as known then; before capture began they are unknown.
- **Stored readings carry provenance.** Each is observed at the time, a point-in-time reconstruction, recomputed later, or unknown. A recomputation never replaces a reading measured at the time.
- **The upper attribution rungs are guarded.** They need point-in-time readings and objectively observed results. Staff declarations are kept, labelled, and never counted as observed.
- **`training/training-contract.ts` defines training-safe data.** There is no model.

### What the database cannot tell us

- **Anything before history capture began.** See HISTORY.md section 8.
- **Whether a message was delivered or read.** Outreach is a completion a person declared, not an observed contact.
- **When an action was actually done.** `completed_at` is when it was declared.
- **Why a patient did not return.** Only that no later visit is recorded.
- **Anything about a day with no snapshot.** A missing snapshot, or an empty one from before run health was tracked, is unknown, never "nothing was shown".

### Known limits, not fixed here

- Shared core queries the briefing's target counts and messages rely on
  (`getOverdueFollowUps`, planned-without-visit, the `clinic_outstanding_balances`
  RPC) are not paged. They are core-app code outside the Business Brain.
- `getClinicConfig` falls back to defaults when `clinic_settings` cannot be read,
  app-wide; the Business Brain's own repository throws instead.
- The dashboard still computes cumulative totals from live rows each load.
- No retention purge is scheduled yet for `finding_snapshots`,
  `clinic_memory_builds`, `action_completions`, `metric_observations` or the
  state-history tables. Each accepts one (`app.purge_context = 'retention'`), but
  `run_retention_purge` does not include them: its table list is fixed at
  migration time.
- The retention purge of `metric_history` and `queue_entries` removes the current
  view and queue rows. The observations in `metric_observations` outlive them.
- The dentist RLS policies still permit hard DELETE on appointments, treatments,
  follow-ups, payments and patients. A hard delete of any row with history now
  fails, rather than erasing the history with it, but the policies themselves
  should be dropped in favour of soft deletes.
