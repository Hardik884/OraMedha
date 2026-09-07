# CLAUDE.md — OraMedha

> **Single source of truth for all AI-assisted and human development on the OraMedha project.**
> Every engineer or AI coding agent working on this codebase must read this document before writing any code.

---

## Table of Contents

1. [Product Overview](#1-product-overview)
2. [Tech Stack](#2-tech-stack)
3. [User Roles & Permissions](#3-user-roles--permissions)
4. [Core Modules](#4-core-modules)
5. [Detailed Feature Requirements](#5-detailed-feature-requirements)
6. [Dashboard Requirements](#6-dashboard-requirements)
7. [Analytics Requirements](#7-analytics-requirements)
8. [AI Features](#8-ai-features)
9. [n8n Workflows](#9-n8n-workflows)
10. [Multi-Tenant Architecture](#10-multi-tenant-architecture)
11. [Database Schema](#11-database-schema)
12. [Project Structure](#12-project-structure)
13. [Development Principles](#13-development-principles)
14. [Non-Goals for MVP](#14-non-goals-for-mvp)
15. [Environment Variables](#15-environment-variables)
16. [Future Scalability Notes](#16-future-scalability-notes)
17. [Appendix: Key Type Definitions](#appendix-key-type-definitions)

---

## 1. Product Overview

### What is OraMedha?

OraMedha is an AI-powered dental practice management system designed specifically for small and medium dental clinics. It centralises patient records, appointment scheduling, real-time queue management, treatment tracking, payments, and analytics into a single web application — augmented with AI features that surface insights and assist clinical and administrative workflows.

### Problems It Solves

| Problem | How OraMedha Addresses It |
|---|---|
| Paper-based or fragmented patient records | Centralised digital patient profiles with full visit history |
| Manual appointment booking and rescheduling | Structured appointment lifecycle with source tracking |
| No visibility into the waiting room | Real-time queue management with live position updates |
| Inconsistent treatment documentation | Structured treatment records with notes, cost, and status |
| Difficulty tracking outstanding payments | Payment ledger with outstanding balance per patient |
| No data-driven decision making | Built-in analytics across appointments, revenue, and patients |
| Reactive practice management | AI-generated insights and a conversational Clinic Copilot |

### Target Users

- **Dentists** — Clinical owners or practitioners who need full access to clinical and business data.
- **Receptionists** — Front-desk staff who manage bookings, check-ins, and payments.
- **Patients** — Individuals who use the patient portal to book, track appointments, and review their history.

---

## 2. Tech Stack

| Layer | Technology |
|---|---|
| Framework | Next.js 15 (App Router) |
| Language | TypeScript (strict mode) |
| Database & Backend | Supabase (PostgreSQL) |
| Authentication | Supabase Auth |
| Real-time | Supabase Realtime |
| AI Model | Gemini 3.1 Flash Lite |
| Automation | n8n |
| Styling | Tailwind CSS |
| UI Components | shadcn/ui |

### Key Conventions

- Use **Server Actions** as the primary data mutation pattern. Avoid API routes unless absolutely necessary (e.g., webhooks, n8n callbacks).
- Use **Next.js App Router** exclusively. No Pages Router.
- Supabase client is split: `createServerClient` for server components/actions, `createBrowserClient` for client components.
- All database access must enforce **Row Level Security (RLS)** policies scoped to `clinic_id`.

---

## 3. User Roles & Permissions

Roles are stored in the `profiles` table and enforced via Supabase RLS policies and middleware route guards.

### Authentication entry points

OraMedha has **three separate sign-in pages, one per audience**. They are separate so
that no page has to ask a visitor to describe themselves:

| Route | For | Notes |
|---|---|---|
| `/login` | dentists + receptionists | No clinic dropdown, no role picker |
| `/patient/login` | existing patients | No clinic dropdown |
| `/patient/signup` | new patients | The **only** place a clinic is chosen |
| `/patient/verify-email` | new patients, mid-signup | "Check your email"; resend + change address |
| `/admin/login` | the platform admin | Not linked from anywhere; not indexed |

The rule that makes this safe: **nothing about identity comes from the browser.** Each
form posts an email and a password and nothing else. Role, `clinic_id` and admin
capability are all read from the caller's `profiles` row server-side, after the password
check (`actions/auth.ts`). Each entry point then refuses accounts belonging to a
different audience and signs the rejected session straight back out.

The clinic id chosen on `/patient/signup` is validated against the `clinics` table before
it scopes anything — a brand-new patient has no record for the server to read a clinic
from, which is the only reason the field exists at all.

### Email confirmation

Email confirmation is **ON** in every environment. `auth.signUp` therefore returns no
session, and the new account cannot be used until the link in the inbox is opened — so
signup hands off to `/patient/verify-email` rather than to `/portal/setup`, which at that
moment could do nothing and could not say why.

Supabase Auth is the whole of authentication; only the mail **transport** differs by
environment. OraMedha never composes or sends an auth email, holds a mail-provider
credential, or stores a verification token.

| Mode | Transport | Reaches |
|---|---|---|
| local | Mailpit (`http://127.0.0.1:55324`) | anyone |
| `default` | Supabase's built-in service | **project team members**, 2/hour |
| `resend-test` | Resend via `onboarding@resend.dev` | **the Resend account owner only**, 100/day |
| `resend` | Resend from a verified domain | anyone |

**Only `resend` can email a patient, and it needs a domain OraMedha does not own yet.**
The two no-domain options each reach exactly one small audience — a Supabase project
team, or the single address the Resend account was created with — so the hosted project
is a working *staging* setup and **not a patient-facing signup path** under either.
Both restrictions are vendor policy, not settings: Supabase refuses non-team recipients
with `Email address not authorized`, and Resend refuses non-owner recipients from its
shared domain with a 403
([docs](https://resend.com/docs/knowledge-base/403-error-resend-dev-domain)).

Switching transport is one flag on `npm run auth:email:push` and touches configuration
only — no application code, templates or tests. `npm run auth:email:probe` asks the real
Resend SMTP server what the account may actually send, rather than trusting either the
documentation or this file.

`describeEmailSendFailure` (`lib/auth/verification.ts`) classifies send failures so a
patient sees a real wait time or "contact your clinic" rather than a raw provider error,
and the operator gets the cause in the log.

Every link is a `{{ .TokenHash }}` link verified by `/auth/callback`, never
`{{ .ConfirmationURL }}` — the latter finishes in the PKCE flow and dies when the email
is opened on a different device than the one that signed up.

The full architecture, the production checklist and the DNS records Resend needs are in
**`supabase/EMAIL.md`**. Templates live in `supabase/templates/`.

### The `is_admin` capability

`profiles.is_admin` is an **additive** flag, not a fourth role. An admin keeps its normal
`role` and `clinic_id` and behaves like any other staff member inside the app; the flag
only gates `/admin` and `/admin/login`.

It was deliberately not modelled as a `user_role` enum value: the OraMedha owner account
(`owner@dentgrow.local`) is also the dentist of "My Dental Clinic", the development clinic
the Business Brain dashboard is allow-listed to, and changing its role would strip that
access and break every RLS policy expressed in terms of `auth_role()`.

Guarantees (migration `20260821000000_platform_admin_flag.sql`):

- The `profiles` UPDATE policy pins `is_admin` to its pre-update value, so no client can
  grant itself the flag — the same protection `role` and `clinic_id` already had.
- `auth_is_admin()` is the `stable security definer` companion to `auth_role()` /
  `auth_clinic_id()`, safe to call from inside a `profiles` policy.
- **Admin is a door, not an RLS bypass.** The admin account reads clinic data exactly as
  the dentist of its own clinic does. `/admin` reads cross-clinic *aggregate counts only*,
  through the service-role client, and shows no patient rows.
- The `/admin` URL is not a secret and is not the security boundary. `requireAdmin()`
  (`lib/auth/session.ts`) re-checks the flag server-side on every render.

### Role: `dentist`

Full access to all modules and data within their clinic.

| Module | Access |
|---|---|
| Patients | Create, read, update, delete |
| Appointments | Create, read, update, cancel, reschedule |
| Queue | Read, manage (advance, skip) |
| Treatments | Create, read, update, delete |
| Payments | Create, read, update |
| Analytics | Full dashboard + all reports |
| AI Features | Patient summary, Copilot, Insights |
| Settings | Clinic settings, user management |

### Role: `receptionist`

Operational access for front-desk workflows. No access to clinical treatment details or analytics.

| Module | Access |
|---|---|
| Patients | Create, read, update (no delete) |
| Appointments | Create, read, update, cancel, reschedule |
| Queue | Check-in patients, view waiting queue, advance queue |
| Payments | Create, read, update |
| Check-ins | Full access |
| Analytics | None |
| AI Features | None |

### Role: `patient`

Self-service portal access. Patients can only see their own data.

| Module | Access |
|---|---|
| Appointments | Book new (view available slots), view own, cancel future appointments |
| Queue | View own queue position and estimated wait time (real-time) |
| Treatment History | View own completed treatments |
| Payments | View own payment history and outstanding balance |
| Follow-Ups | View own pending follow-ups |
| AI Assistant | Conversational access to own data via Patient AI Assistant |

---

## 4. Core Modules

### 4.1 Patient Management

Central registry of all patients belonging to a clinic. Each patient record aggregates visits, treatments, and payment history. Supports search, filtering, and AI-powered summaries.

### 4.2 Appointment Management

Structured booking lifecycle from creation through completion. Tracks the source of each booking and maintains a full status history. Supports rescheduling and cancellation with reason capture.

### 4.3 Queue Management

Real-time waiting room management. Patients are checked in upon arrival and placed in a queue. The dentist or receptionist advances the queue. All connected clients receive live updates via Supabase Realtime.

### 4.4 Treatment Management

Per-appointment clinical records. Each treatment is linked to a patient and an appointment. Dentists document treatment type, notes, cost, and status.

### 4.5 Payment Management

Financial ledger at the patient level. Tracks individual payment transactions and calculates outstanding balances. Supports multiple payment methods.

### 4.6 Analytics

Read-only reporting module for dentists. Aggregates data across appointments, patients, treatments, and revenue. Visualised with charts built on top of the analytics data layer.

### 4.7 Patient Portal

A separate, simplified UI for patients. Authenticated patients can view available slots, book and cancel appointments, check their real-time queue position and estimated wait time, and review their treatment history, payment history, and outstanding balance. The portal also surfaces the Patient AI Assistant chatbot.

### 4.8 Follow-Up Management

Tracks treatment follow-ups and future recall visits. Follow-ups are linked to a patient, appointment, and optionally a treatment. They have a due date and status, and are visible on the patient profile, analytics, and surfaced by AI Insights.

### 4.9 AI Features

Four AI-powered capabilities powered by Gemini 3.1 Flash Lite:
- **Patient Summary** — Generates a natural-language summary of a patient's history.
- **Clinic Copilot** — Conversational assistant for dentists and receptionists.
- **AI Insights** — Proactive, data-driven observations surfaced on the dentist dashboard, including follow-up detection.
- **Patient AI Assistant** — Conversational chatbot in the patient portal for booking, queue, history, and clinic FAQ queries.

### 4.10 Clinic Settings

Stores clinic-specific configuration and operational settings. Used by the Patient AI Assistant for clinic FAQ responses, by queue logic for wait-time estimation, and by appointment scheduling for slot duration defaults. Replaces any hardcoded clinic information in prompts or business logic.

### 4.11 Availability Management

Controls appointment booking slots. Dentists define recurring weekly availability rules (day, start time, end time, slot duration). Available slots are generated dynamically from these rules minus existing appointments. Used by the patient portal, receptionist booking UI, and Patient AI Assistant.

### 4.12 Patient Portal Account Linking

Manages the optional link between a patient record and a Supabase Auth account. Patient records exist independently of authentication. A `patient_portal_links` join table connects a patient to a portal account only when the patient chooses to register. This supports receptionist-created records, patient self-registration, and clinics where most patients never use the portal.

---

## 5. Detailed Feature Requirements

### 5.1 Patients

Each patient record must store the following fields:

| Field | Type | Notes |
|---|---|---|
| `id` | `uuid` | Primary key |
| `clinic_id` | `uuid` | Foreign key → `clinics.id` |
| `name` | `text` | Full name, required |
| `phone` | `text` | Primary contact number |
| `date_of_birth` | `date` | Used to calculate age dynamically |
| `gender` | `enum` | `male`, `female`, `other` |
| `address` | `text` | Optional |
| `emergency_contact_name` | `text` | Optional |
| `emergency_contact_phone` | `text` | Optional |
| `notes` | `text` | Free-form clinical or admin notes |
| `total_visits` | `integer` | Computed or maintained counter |
| `last_visit` | `timestamptz` | Timestamp of most recent completed appointment |
| `deleted_at` | `timestamptz` | Soft delete timestamp; null = active |
| `created_at` | `timestamptz` | Auto-set |
| `updated_at` | `timestamptz` | Auto-updated |

> **Age** is never stored as a column. It is always calculated at query/render time from `date_of_birth` using `EXTRACT(YEAR FROM AGE(date_of_birth))` in SQL or equivalent in application code.

**Behaviours:**
- `total_visits` increments when an appointment status transitions to `completed`.
- `last_visit` updates on the same `completed` transition.
- Phone number must be validated for format before save.
- Patient search must support partial match on `name` and `phone`.
- Patient profile must display pending follow-ups (from the `follow_ups` table).

---

### 5.2 Appointments

| Field | Type | Notes |
|---|---|---|
| `id` | `uuid` | Primary key |
| `clinic_id` | `uuid` | Foreign key → `clinics.id` |
| `patient_id` | `uuid` | Foreign key → `patients.id` |
| `dentist_id` | `uuid` | Foreign key → `profiles.id` (role: dentist) |
| `scheduled_at` | `timestamptz` | Date and time of appointment |
| `duration_minutes` | `integer` | Default 30 |
| `source` | `enum` | See sources below |
| `status` | `enum` | See statuses below |
| `notes` | `text` | Optional appointment-level notes |
| `deleted_at` | `timestamptz` | Soft delete timestamp; null = active |
| `created_at` | `timestamptz` | Auto-set |
| `updated_at` | `timestamptz` | Auto-updated |

**Appointment Sources:**

| Value | Label |
|---|---|
| `walk_in` | Walk-in |
| `phone_call` | Phone Call |
| `website` | Website |
| `referral` | Referral |
| `other` | Other |

**Appointment Statuses (ordered lifecycle):**

| Value | Description |
|---|---|
| `scheduled` | Booked, not yet arrived |
| `checked_in` | Patient arrived and checked in |
| `in_progress` | Currently being seen |
| `completed` | Visit finished |
| `cancelled` | Cancelled before visit |
| `no_show` | Patient did not arrive |

**Behaviours:**
- Status transitions must follow the lifecycle order. Invalid transitions (e.g., `completed` → `scheduled`) must be rejected.
- Cancellation and `no_show` are terminal states.
- On `completed`, trigger update of `patients.total_visits` and `patients.last_visit`.
- Rescheduling updates `scheduled_at` on the existing record; the original value and actor are recorded in `appointment_history`.
- Every status change must write a row to `appointment_history` (see Section 5.7).

---

### 5.3 Queue

The queue is a real-time view of patients who have checked in for the current day at a clinic.

| Field | Type | Notes |
|---|---|---|
| `id` | `uuid` | Primary key |
| `clinic_id` | `uuid` | Foreign key → `clinics.id` |
| `appointment_id` | `uuid` | Foreign key → `appointments.id` |
| `patient_id` | `uuid` | Foreign key → `patients.id` |
| `position` | `integer` | Order in queue, 1-indexed |
| `status` | `enum` | `waiting`, `in_progress`, `completed` |
| `checked_in_at` | `timestamptz` | When the patient was checked in |
| `called_at` | `timestamptz` | When the patient was called in |

**Behaviours:**
- Check-in creates a queue entry with the next available `position`.
- Only one patient can be `in_progress` at a time per clinic.
- Advancing the queue moves the current `in_progress` patient to `completed` and promotes the next `waiting` patient to `in_progress`.
- Queue position is recalculated after any removal or skip.
- **Supabase Realtime** must broadcast queue changes to all subscribed clients so patients and staff see live updates without polling.
- Queue resets daily (entries are scoped to today's date).

---

### 5.4 Treatments

| Field | Type | Notes |
|---|---|---|
| `id` | `uuid` | Primary key |
| `clinic_id` | `uuid` | Foreign key → `clinics.id` |
| `appointment_id` | `uuid` | Foreign key → `appointments.id` |
| `patient_id` | `uuid` | Foreign key → `patients.id` |
| `treatment_type` | `text` | E.g. "Root Canal", "Cleaning", "Extraction" |
| `internal_notes` | `text` | Clinical notes visible to dentist only |
| `patient_visible_notes` | `text` | Notes visible to the patient in the portal |
| `cost` | `numeric(10,2)` | Treatment cost in local currency |
| `status` | `enum` | `planned`, `in_progress`, `completed`, `cancelled` |
| `performed_at` | `timestamptz` | When the treatment was performed |
| `deleted_at` | `timestamptz` | Soft delete timestamp; null = active |
| `created_at` | `timestamptz` | Auto-set |
| `updated_at` | `timestamptz` | Auto-updated |

**Note visibility rules:**
- `internal_notes` — visible only to dentist. Never returned by patient-facing
  APIs or portal queries. **Enforced by a column GRANT, not by convention**
  (`20260907000100`): it is withheld from `anon` and `authenticated`, so it
  cannot be selected through the Data API by any query shape. A dentist reads it
  through the `treatment_clinical_notes` projection. Until that migration the
  rule was enforced only by views that omitted the column, and both a portal
  patient and a receptionist could read it straight off the base table.
- `patient_visible_notes` — visible in the patient portal and returned by `getPatientTreatments` tool. Should contain only information appropriate for the patient to read (e.g., "Filling completed on upper left molar").
- Both fields are always editable, even after the treatment is `completed`.

**Behaviours:**
- `cost` contributes to the patient's outstanding balance calculation if unpaid.
- Multiple treatments can exist per appointment.
- Soft-deleted treatments are excluded from all default queries, balance calculations, and AI context. They remain in the database for audit purposes.

---

### 5.5 Payments

| Field | Type | Notes |
|---|---|---|
| `id` | `uuid` | Primary key |
| `clinic_id` | `uuid` | Foreign key → `clinics.id` |
| `patient_id` | `uuid` | Foreign key → `patients.id` |
| `appointment_id` | `uuid` | Optional FK → `appointments.id` |
| `amount` | `numeric(10,2)` | Amount paid |
| `method` | `enum` | `cash`, `upi`, `card`, `bank_transfer` |
| `payment_date` | `date` | Date payment was received |
| `notes` | `text` | Optional notes |
| `deleted_at` | `timestamptz` | Soft delete timestamp; null = active |
| `created_at` | `timestamptz` | Auto-set |

**Outstanding Balance:**
- Calculated as: `SUM(treatments.cost) - SUM(payments.amount)` per patient.
- This must be computed server-side, never trusted from the client.
- Expose as a read-only derived value on the patient profile.

---

### 5.6 Follow-Ups

Tracks required follow-up visits and recall reminders linked to a patient.

| Field | Type | Notes |
|---|---|---|
| `id` | `uuid` | Primary key |
| `clinic_id` | `uuid` | Foreign key → `clinics.id` |
| `patient_id` | `uuid` | Foreign key → `patients.id` |
| `appointment_id` | `uuid` | Optional FK → `appointments.id` (originating appointment) |
| `treatment_id` | `uuid` | Optional FK → `treatments.id` |
| `due_date` | `date` | When the follow-up should occur |
| `status` | `enum` | `pending`, `completed`, `cancelled` |
| `notes` | `text` | Reason or description of follow-up |
| `deleted_at` | `timestamptz` | Soft delete timestamp; null = active |
| `created_at` | `timestamptz` | Auto-set |
| `updated_at` | `timestamptz` | Auto-updated |

**Use cases:**
- Root canal review
- Crown placement follow-up
- Cleaning recall (every 6 months)
- Implant review

**Behaviours:**
- A follow-up with `due_date < today` and `status = pending` is considered **overdue**.
- Overdue follow-ups are surfaced in AI Insights and Follow-Up Analytics.
- Dentist can create, update, and complete/cancel follow-ups from the patient profile.
- Follow-ups are visible in the patient portal under the patient's profile.

---

### 5.7 Appointment History

Audit trail for all changes to an appointment record.

| Field | Type | Notes |
|---|---|---|
| `id` | `uuid` | Primary key |
| `appointment_id` | `uuid` | Foreign key → `appointments.id` |
| `action` | `text` | e.g. `created`, `rescheduled`, `cancelled`, `status_changed` |
| `old_value` | `jsonb` | Previous value(s) of changed field(s) |
| `new_value` | `jsonb` | New value(s) of changed field(s) |
| `performed_by` | `uuid` | Foreign key → `profiles.id` (who made the change) |
| `timestamp` | `timestamptz` | When the change occurred, default `now()` |

**Behaviours:**
- Written automatically by the Server Action that mutates the appointment — never written directly from the client.
- `old_value` and `new_value` store only the fields that changed (e.g., `{ "scheduled_at": "2026-06-18T10:00:00Z" }`).
- History is read-only; records must never be updated or deleted.
- No RLS write access for any role — inserts happen via service role in server actions only.

---

### 5.8 Patient Portal Account Linking

Patient records and Supabase Auth accounts are **intentionally decoupled**. A clinic may have thousands of patient records created by receptionists; only a subset of those patients will ever register for portal access.

**Entity: `patient_portal_links`**

| Field | Type | Notes |
|---|---|---|
| `id` | `uuid` | Primary key |
| `patient_id` | `uuid` | Foreign key → `patients.id` — unique |
| `user_id` | `uuid` | Foreign key → `auth.users.id` — unique |
| `created_at` | `timestamptz` | Auto-set |

**Constraints:**
- `patient_id` has a `UNIQUE` constraint — one patient can have at most one portal account.
- `user_id` has a `UNIQUE` constraint — one portal account can belong to only one patient.
- `clinic_id` is not stored here; it is derived from `patients.clinic_id` via join.

**Three valid states:**

| State | Description |
|---|---|
| Patient record only | Receptionist created the patient; no portal access. Default for walk-in and phone bookings. |
| Patient record + portal link | Patient registered for the portal; `patient_portal_links` row exists. |
| Auth account only | User signed up but has not been linked to a patient record yet. Must be resolved before portal access is granted. |

**Registration workflow:**
1. Receptionist creates a patient record in the system (no auth involved).
2. Patient visits `/patient/signup`, **chooses their clinic**, and creates an auth account.
   The chosen `clinic_id` is validated server-side and carried to step 3 in an httpOnly
   cookie, so the lookup below is scoped to that clinic only — the same phone number at a
   different clinic is never matched.
3. `/portal/setup` matches the auth account to an existing patient record by phone number
   (or clinic-defined matching criteria).
4. If a match is found, a `patient_portal_links` row is created and the patient gains portal access.
5. If no match is found, a new patient record is created in the chosen clinic and linked.

An **existing** patient never repeats this. They sign in at `/patient/login` with email and
password only; their clinic is resolved through `patient_portal_links` → `patients.clinic_id`.
Clinic selection appears on the signup form and nowhere else.

**RLS implication:**
- Patient portal RLS policies must use `patient_portal_links.user_id = auth.uid()` to resolve the patient's `patient_id`, then scope all queries to that `patient_id`.
- `patients.user_id` does not exist. Never add it directly to the `patients` table.

---

### 5.9 Clinic Settings

Clinic-specific configuration stored per clinic. Used as the source of truth for operational parameters across scheduling, queue estimation, AI prompts, and future automations.

**Entity: `clinic_settings`**

| Field | Type | Notes |
|---|---|---|
| `clinic_id` | `uuid` | Primary key + FK → `clinics.id` (one-to-one) |
| `clinic_name` | `text` | Display name used in communications |
| `phone` | `text` | Clinic contact phone |
| `email` | `text` | Clinic contact email |
| `address` | `text` | Full clinic address |
| `clinic_hours` | `jsonb` | Operating hours per day (see format below) |
| `average_appointment_duration` | `integer` | Minutes; used for wait-time estimation. Default: 30 |
| `chair_count` | `integer` | Treatment chairs usable at once. Default: 1, minimum 1 |
| `created_at` | `timestamptz` | Auto-set |
| `updated_at` | `timestamptz` | Auto-updated |

**`clinic_hours` JSON format:**
```json
{
  "monday":    { "open": "09:00", "close": "18:00", "is_open": true },
  "tuesday":   { "open": "09:00", "close": "18:00", "is_open": true },
  "wednesday": { "open": "09:00", "close": "18:00", "is_open": true },
  "thursday":  { "open": "09:00", "close": "18:00", "is_open": true },
  "friday":    { "open": "09:00", "close": "17:00", "is_open": true },
  "saturday":  { "open": "10:00", "close": "14:00", "is_open": true },
  "sunday":    { "open": null,    "close": null,    "is_open": false }
}
```

**Used by:**
- Patient AI Assistant `getClinicInformation` tool — clinic hours, phone, address, email are read from here, never hardcoded in prompts.
- Queue wait-time estimation — `average_appointment_duration` drives the formula.
- Capacity measurement — `chair_count` multiplies open time into total treatable capacity (see the note under Slot generation).
- Appointment scheduling — slot boundaries respect clinic hours.
- Future n8n reminder workflows — contact details sourced from here.

---

### 5.10 Availability Rules

Weekly recurring rules that define when appointment slots are available.

**Entity: `availability_rules`**

| Field | Type | Notes |
|---|---|---|
| `id` | `uuid` | Primary key |
| `clinic_id` | `uuid` | Foreign key → `clinics.id` |
| `day_of_week` | `integer` | 0 = Sunday … 6 = Saturday |
| `start_time` | `time` | Slot window start (e.g. `09:00`) |
| `end_time` | `time` | Slot window end (e.g. `13:00`) |
| `slot_duration_minutes` | `integer` | Duration of each slot (e.g. 30) |
| `is_active` | `boolean` | Whether this rule is currently enabled |
| `created_at` | `timestamptz` | Auto-set |
| `updated_at` | `timestamptz` | Auto-updated |

**Example rules:**

| Day | Start | End | Slot Duration |
|---|---|---|---|
| Monday (1) | 09:00 | 13:00 | 30 min |
| Monday (1) | 14:00 | 18:00 | 30 min |
| Saturday (6) | 10:00 | 14:00 | 30 min |

**Slot generation (`getAvailableSlots`):**
- Available slots are generated dynamically at query time — they are not pre-materialised in the database.
- Algorithm: for each active rule matching the requested date's `day_of_week`, generate all slot start times between `start_time` and `end_time` at `slot_duration_minutes` intervals, then subtract slots already occupied by existing appointments with status not in (`cancelled`, `no_show`).
- Double-booking prevention: a slot is occupied if any appointment exists at the same `dentist_id` + `scheduled_at`.
- `getAvailableSlots(date, clinicId)` is a typed server-side function used by the patient portal, receptionist UI, and Patient AI Assistant tool.

> ⚠️ **`slot_duration_minutes` is a STEP SIZE, not a unit of capacity.** The slots
> `getAvailableSlots` returns are candidate *start times*, and they OVERLAP — a
> 09:00–13:00 rule stepped every 10 minutes yields 24 of them for four hours of
> chair time. The function is correct for booking, because it separately checks
> that a full appointment fits inside the window. But counting its results is
> never a measure of how much work a clinic can do: it inflates capacity by the
> ratio of appointment length to step size, and because clinics set different
> steps on different weekdays, the same clinic reads differently on a Monday than
> a Friday.
>
> **To measure capacity, use `openMinutes(rules, blocks)` from
> `lib/scheduling/slots.ts`** — the union of the day's rule windows less any
> consultancy block — and multiply by `clinic_settings.chair_count`. Booked
> capacity is the sum of `appointments.duration_minutes`, never an appointment
> count, since real appointments run from 10 to 60 minutes.

**Future support:** the `availability_rules` table is designed to support per-dentist rules (add `dentist_id` column) when multi-dentist scheduling is introduced.

---

### 5.11 Soft Delete Strategy

The following tables support soft deletion via a `deleted_at timestamptz` column:

- `patients`
- `appointments`
- `treatments`
- `payments`
- `follow_ups`
- `treatment_documents` (since `20260903000300` — removal is an UPDATE setting
  `deleted_at`, and the RLS DELETE policy was dropped so the hard route is
  closed rather than merely unused; the storage object is cleared later by the
  retention purge)

**Rules:**
- Records are **never physically deleted** from the database.
- All default Supabase queries and Server Actions must include a `WHERE deleted_at IS NULL` filter, or use a database view that applies this filter automatically.
- RLS policies must also enforce `deleted_at IS NULL` for standard read access.
- Deleted records remain accessible to superadmin queries for audit purposes.
- AI features (Patient Summary, Copilot, Insights, Patient AI Assistant) must only receive non-deleted records. Deleted data must never appear in AI context.
- Soft deletion of a patient cascades logically. The cascade covers
  appointments, treatments, payments, follow-ups, **the dental chart
  (`patient_teeth`), treatment documents and consents**; it removes reminder
  records and active queue entries outright and unlinks the portal account.
  `actions/__tests__/patient-cascade-completeness.spec.ts` reads the migrations,
  finds every table with a foreign key to `patients`, and fails unless the
  cascade handles it or that spec records in writing why not — because the way a
  cascade stops being complete is a table added months later by someone who
  never read it.

**What is NOT soft-deleted, and never purged on a timer:** the audit trails.
`appointment_history`, `consent_audit`, `tooth_history`, `treatment_history`,
`phi_access_log` and `data_consent_records` exist to outlive what they describe.
See `docs/RETENTION.md`.


---

### 5.12 Data-Processing Consent

**Separate from clinical consent, deliberately.** The consent system in §5.9 and
`consents`/`consent_audit` is CLINICAL consent — "I agree to this root canal".
Data-processing consent is a different act with different properties:

| | Clinical consent | Data-processing consent |
|---|---|---|
| Scope | One procedure | Standing |
| Withdrawable | No — it already happened | **Yes** |
| Divisible | No | **Yes, per category** |
| Recorded as | A signature | A choice, plus what was shown |

Bolting categories onto `consent_templates` would have put a revocable consent
inside a table whose whole design rests on signed rows never changing. So it
gets its own model (`20260903000200`):

- `data_consent_notices` — the versioned, immutable plain-language sentence a
  person was shown. A row with `clinic_id IS NULL` is a platform default every
  clinic inherits; a clinic row overrides it.
- `data_consent_records` — append-only decisions, each carrying a **frozen copy**
  of the notice as it read at that moment. A notice can be revised; what someone
  agreed to cannot be revised retroactively.
- `patient_data_consent_state` — a `security_invoker` view giving the latest
  decision per (patient, category).

**Four independent categories:** `data_processing`, `communications`,
`marketing`, `ai_assisted`. Refusing marketing must never withhold care or
operational messages, and there is no coupling anywhere for a future change to
add one to by accident.

**Withdrawal never overwrites.** It is a new row; the grant stays. The only
question this ledger is asked is *"was this lawful at the time"*.

**`data_processing` has no toggle.** A clinic cannot treat someone without
keeping a record of the treatment, and offering a switch the product could not
honour would tell a patient something untrue about what they control.

**`actor` distinguishes** a patient's own choice from a staff member recording
one at the front desk. **Staff access to a record is never treated as the
patient's consent, anywhere.**

**Writes go through the service role** in `actions/data-consent.ts`; there is no
client INSERT policy, the same shape `consent_audit` uses. An append-only
trigger binds the service role too.

**Enforced where it matters:** `buildReachable` removes a patient who has
withdrawn `communications` before a reminder message is composed for them.

---

### 5.13 PHI Read-Access Audit

`phi_access_log` (`20260903000000`) records **who read which record, when, in
what role**. OraMedha recorded writes well and recorded no reads at all, so
"who opened this patient's record" had no answer.

**It stores identifiers only** — never names, phone numbers, clinical content,
amounts, search terms, prompts or credentials. `lib/audit/phi-access.ts` filters
`context` through an allow-list, so `{ patientName }` cannot be written even by
accident. An audit log of PHI reads that itself contains PHI widens the blast
radius of the next incident instead of narrowing it.

**Immutable by two independent mechanisms**, because one of them is the one that
fails: RLS gives the clinic's dentist read access and gives *nobody* a write
policy; and a trigger blocks UPDATE outright and DELETE outside a declared
retention purge — which is what binds the service role, since `service_role`
carries `BYPASSRLS`.

**Call it from reads that resolve a specific person's record**, or that make a
stored document retrievable. Not from every render: a list that repaints on a
filter change is not twenty accesses, and a log full of those buries the row
that matters. A patient reading their **own** record is not recorded — the log
answers who *else* looked.

Use `recordPhiAccess(profile, { … })`. Never insert into the table directly.

---

### 5.14 Treatment History

`treatment_history` (`20260903000300`) is the append-only trail for treatment
records — shaped after `appointment_history` rather than inventing a second
pattern. `old_value`/`new_value` carry **only the fields that changed**
(`diffFields` computes it); passing the whole row would make the trail a second,
less-protected copy of the clinical record, duplicating `internal_notes` on
every save into a table with different readers.

---

## 6. Dashboard Requirements

### 6.1 Dentist Dashboard

The dentist dashboard is the primary landing page after login for users with the `dentist` role. It must display the following KPIs, all scoped to **today** and **current clinic**:

| KPI | Description |
|---|---|
| Total Appointments Today | Count of all appointments scheduled for today |
| Seen Patients Today | Count of appointments with status `completed` today |
| Completion Rate Today | `Seen Patients Today / Total Appointments Today` (percentage) |
| Waiting Patients | Count of queue entries with status `waiting` right now |
| Upcoming Appointments | List of next N appointments still in `scheduled` or `checked_in` status |
| No-Shows | Count of appointments marked `no_show` today |
| Revenue Today | Sum of payments received today |
| New Patients Today | Count of patients whose `created_at` is today |
| Walk-ins Today | Count of today's appointments with `source = walk_in` |

**Additional dentist dashboard elements:**
- AI Insights panel (see Section 8.3)
- Quick-access navigation to Patients, Queue, and Analytics
- Realtime queue widget showing current and next patient

---

### 6.2 Receptionist Dashboard

Focused on operational workflows for the current day:

| Element | Description |
|---|---|
| Today's Appointments | Full list of today's appointments with status badges |
| Waiting Queue | Live queue with position, patient name, and check-in time |
| Upcoming Appointments | Next appointments requiring action |
| Patient Search | Prominent search bar to find patients by name or phone |
| Pending Payments | List of patients with outstanding balance > 0 |

---

### 6.3 Patient Dashboard

Simplified self-service view for patients:

| Element | Description |
|---|---|
| Upcoming Appointments | Their next scheduled appointment(s) |
| Queue Position | Live position in today's queue (if checked in) |
| Estimated Wait Time | Approximate wait based on patients ahead × `clinic_settings.average_appointment_duration` |
| Current Patient Number | Which queue number is currently being seen |
| Treatment History | List of completed treatments |
| Payment History | List of past payments |
| Outstanding Balance | Current amount owed |
| AI Assistant | Persistent chat widget (Patient AI Assistant) |

---

## 7. Analytics Requirements

Analytics are read-only and available only to the `dentist` role. All analytics queries must be scoped to `clinic_id` and support date range filtering (default: last 30 days).

### 7.1 Appointment Analytics

- Total appointments by status (stacked bar chart by day/week/month)
- Cancellation rate over time
- No-show rate over time
- Average appointments per day
- Peak hours heatmap (hour of day vs day of week)

### 7.2 Patient Analytics

- New patients over time (line chart)
- Returning vs new patient ratio
- Patient age distribution (bar chart)
- Gender breakdown (donut chart)
- Top patients by visit count

### 7.3 Treatment Analytics

- Most common treatment types (bar chart)
- Average treatment cost by type
- Treatment completion rate (completed vs cancelled/planned)
- Revenue by treatment type

### 7.4 Revenue Analytics

- Daily/weekly/monthly revenue (line chart)
- Revenue by payment method (donut chart): cash, upi, card, bank_transfer
- Revenue by appointment source (bar chart): walk_in, phone_call, website, referral, other
- Outstanding balance totals
- Average revenue per completed appointment
- Month-over-month growth

### 7.5 Acquisition Source Analytics

- Appointment source breakdown (pie/donut chart): walk-in, phone, website, referral, other
- Source trend over time (stacked area chart)
- Conversion by source (booked vs completed vs no-show by source)

### 7.6 Follow-Up Analytics

- Pending follow-ups count (total and by due-date proximity)
- Completed follow-ups over time (line chart)
- Overdue follow-ups count and list (due_date < today, status = pending)
- Follow-up completion rate (completed / total created)
- Follow-ups by treatment type (which treatments generate the most follow-ups)

---

## 8. AI Features

All AI features use **Gemini 3.1 Flash Lite** via the Google AI SDK. AI calls are always made server-side (Server Actions or Route Handlers). Never expose API keys to the client.

> **Data minimisation is not optional.** A prompt may contain what the model
> needs to do the task and nothing that identifies whose task it is. No patient
> name, phone number, email or date of birth reaches the provider; age is banded
> and last-visit is coarsened to a month. Every outbound prompt passes
> `guardOutboundPrompt()` inside `lib/ai/gemini.ts`, which rejects secrets
> outright and rejects contact identifiers unless a call site waives that rule
> explicitly (exactly one does — the portal assistant, for the CLINIC's own
> published number). Adding a new AI feature means adding it to the declared
> list in `lib/ai/__tests__/ai-surface.spec.ts`, which reads the source and
> fails otherwise. See `docs/AI-DATA-HANDLING.md` — including what is still
> unsettled: no DPA with Google, no established retention position, no verified
> training-use position, no regional control.

> **AI Resilience Principle:** OraMedha must remain fully functional even if Gemini is unavailable. AI features are enhancements only and must never be required for core clinic operations. The following must work without AI: Patients, Appointments, Queue, Treatments, Payments, and Analytics. All AI features must fail gracefully with a user-facing message (e.g., "AI features are temporarily unavailable") and never block or error the surrounding page.

### 8.1 Patient Summary

**Trigger:** Dentist opens a patient profile and clicks "Generate Summary".

**Input to AI:**
- Patient demographics (name, age, gender)
- Total visits and last visit date
- Last N treatment records (type, notes, date, cost, status)
- Outstanding balance
- Any open appointment notes

**Output:** A concise 2–4 paragraph natural-language clinical summary covering:
- Patient background and visit frequency
- Recent treatments and clinical observations from notes
- Financial standing
- Suggested follow-up considerations (non-prescriptive)

**Implementation notes:**
- Summarised with a structured prompt; do not allow free-form user injection into the prompt.
- Response is displayed in a read-only card on the patient profile.
- Response is not stored in the database (generated on demand).

---

### 8.2 Clinic Copilot

**Trigger:** Chat interface available on the dentist and receptionist dashboards.

**Capabilities (examples):**
- "Show today's patients" → returns a formatted list of today's appointments
- "Show pending payments" → lists patients with outstanding balances
- "Identify no-show trends" → analyses no-show rate and highlights patterns
- "Summarise patient history for [name]" → delegates to Patient Summary feature
- "How many walk-ins this week?" → queries appointment source data

**Implementation notes:**
- The Copilot receives a structured system prompt describing the clinic's current context (date, clinic name, logged-in user role).
- The AI does **not** have direct database access. The application resolves a defined set of **tool functions** (structured data fetchers) and passes results into the conversation context.
- Supported tool functions must be explicitly defined and type-safe. No arbitrary SQL generation.
- Conversation history is kept in local component state (not persisted to database in MVP).
- The Copilot must gracefully decline requests outside its defined tool scope.

---

### 8.3 AI Insights

**Trigger:** Automatically generated and displayed on the dentist dashboard. Refreshed on page load or on demand.

**Examples of insights generated:**
- "You had 3 no-shows this week — 40% higher than last week."
- "Walk-in appointments have increased 25% this month."
- "Patient [Name] has an outstanding balance of [amount] from their last visit."
- "Your busiest hour this week was 10–11 AM."
- "Revenue is down 15% compared to the same period last month."
- "Patient [Name] had a root canal 45 days ago and has no crown appointment scheduled — may require follow-up."
- "You have 5 overdue follow-ups this week."

**Follow-Up Detection Logic:**
The AI receives a structured payload that includes treatments completed 30+ days ago alongside the patient's subsequent appointment and treatment records. It identifies gaps — for example, a completed root canal with no crown treatment recorded within a reasonable window — and flags them as potential follow-up needs. This is observational only; the AI does not issue clinical recommendations.

**Implementation notes:**
- A fixed set of metrics is fetched server-side and passed to Gemini as structured JSON.
- The AI returns 3–5 bullet-point insights in plain language.
- Insights are displayed in a card on the dentist dashboard.
- Results are not stored; regenerated on each dashboard load.
- If Gemini is unavailable, the Insights panel shows a non-blocking fallback message.

---

### 8.4 Patient AI Assistant

**Trigger:** Persistent chat widget available inside the patient portal for authenticated patients.

**Purpose:** Allow patients to interact with their own clinic data through natural language, and get answers to common clinic questions — without needing to navigate multiple pages.

**Capabilities:**

| Category | Example Queries |
|---|---|
| Appointments | "I need an appointment tomorrow evening", "Do I have any upcoming appointments?" |
| Rescheduling | "Reschedule my appointment to Friday" |
| Cancellation | "Cancel my appointment on Thursday" |
| Queue | "How many patients are ahead of me?", "What is the estimated wait time?" |
| Treatment History | "What treatments have I had?" |
| Payments | "Do I have any outstanding balance?", "Show my payment history" |
| Clinic FAQ | "What are the clinic timings?", "What is the clinic phone number?" |

**Implementation Architecture:**

- Powered by **Gemini 3.1 Flash Lite** with tool-calling and structured outputs.
- All AI calls are made server-side via a dedicated Server Action or API route.
- The assistant uses a **tool-calling architecture**: the model declares which tool it needs to call, the application executes it server-side, and the result is passed back into the conversation context.
- The model has **no direct database access**. All data access goes through the defined application tool functions below.

**Allowed Tools:**

| Tool | Description |
|---|---|
| `getAvailableSlots` | Returns open appointment slots for a given date range |
| `createAppointment` | Books a new appointment for the authenticated patient |
| `rescheduleAppointment` | Moves an existing appointment to a new slot |
| `cancelAppointment` | Cancels a future appointment owned by the patient |
| `getQueueStatus` | Returns the patient's current queue position, patients ahead, and estimated wait time |
| `getPatientAppointments` | Returns the patient's upcoming and past appointments |
| `getPatientTreatments` | Returns the patient's treatment history |
| `getPatientPayments` | Returns the patient's payment history and outstanding balance |
| `getClinicInformation` | Returns clinic info from `clinic_settings`: name, address, phone, email, hours |

**Data Scope:**
- Every tool function is scoped to the authenticated patient's `patient_id` and `clinic_id` from the server session.
- A patient cannot query or mutate data belonging to another patient.
- Tool inputs from the model are validated server-side before any database call.

**Safety Restrictions:**

The assistant **must not**:
- Diagnose dental conditions
- Recommend medications or dosages
- Provide treatment plans or clinical advice
- Replace professional dental consultation

For any medically oriented question, the assistant must respond with:
> "Please consult your dentist for medical advice."

**Conversation handling:**
- Conversation history is held in local component state for the session; not persisted to the database.
- The assistant must gracefully decline requests outside its defined tool scope.
- **Action confirmation required:** The assistant must never execute a mutating tool (`createAppointment`, `rescheduleAppointment`, `cancelAppointment`) without first presenting the action to the patient and receiving explicit confirmation. Example flow: AI proposes "I found a slot at 5 PM tomorrow — shall I book it?", patient confirms, then and only then is `createAppointment` called.
- If Gemini is unavailable, the chat widget shows a non-blocking fallback: "The AI assistant is temporarily unavailable. Please use the menu to manage your appointments."

---

## 9. n8n Workflows

n8n is integrated for automation workflows. In MVP, the infrastructure is set up but workflows are not yet active. The application should expose webhook endpoints that n8n can call, and n8n should be able to call back into the application via secure API routes.

### Planned Workflows (Post-MVP)

| Workflow | Trigger | Action |
|---|---|---|
| Appointment Reminder | 24h before `scheduled_at` | Send SMS/email reminder to patient |
| Follow-up Task | Appointment status → `completed` | Create follow-up reminder for dentist |
| Payment Reminder | Outstanding balance > 0 for 7+ days | Send payment reminder to patient |
| Analytics Report | Weekly cron | Generate and email weekly summary to dentist |
| No-Show Alert | Appointment marked `no_show` | Notify receptionist to follow up |
| Follow-Up Reminder | Follow-up `due_date` is within 3 days, status = `pending` | Send reminder to patient and dentist |
| Overdue Follow-Up Detection | Daily cron — `due_date < today`, status = `pending` | Flag overdue follow-ups; notify dentist |
| Appointment Reminder Automation | 48h and 2h before `scheduled_at` | Multi-stage reminder sequence to patient |
| Payment Reminder Automation | Outstanding balance > 0 for 3, 7, 14 days | Escalating payment reminder to patient |

### MVP Integration Requirements

- Create a dedicated `/api/webhooks/n8n` route handler that validates a shared secret before processing.
- Expose typed payload schemas for each webhook event type.
- Log all incoming webhook calls to a `webhook_logs` table for debugging.
- Do not implement workflow logic in the MVP — only the skeleton infrastructure.

---

## 10. Multi-Tenant Architecture

OraMedha is a multi-tenant SaaS product. Each clinic is a tenant. **All data isolation is enforced at the database level via Row Level Security (RLS), not just at the application level.**

### Core Rules

1. Every major entity table must have a `clinic_id uuid NOT NULL` column with a foreign key to `clinics.id`.
2. Every RLS policy must include `clinic_id = (SELECT clinic_id FROM profiles WHERE id = auth.uid())`.
3. The `profiles` table links each Supabase Auth user to a `clinic_id` and a `role`.
4. Middleware must validate the user's session and role on every protected route before rendering.
5. Server Actions must re-validate `clinic_id` from the server session — never trust `clinic_id` from the client request body.

### Tenant-Scoped Tables

The following tables require `clinic_id`:

- `patients`
- `appointments`
- `appointment_history`
- `queue_entries`
- `treatments`
- `payments`
- `follow_ups`
- `clinic_settings`
- `availability_rules`
- `webhook_logs`

> `patient_portal_links` does not carry `clinic_id` directly. Clinic scoping for portal links is resolved via `patients.clinic_id` through a join.

### Patient Portal RLS

Patient-facing RLS policies follow a two-step ownership pattern:

1. Resolve the `patient_id` for the authenticated user: `SELECT patient_id FROM patient_portal_links WHERE user_id = auth.uid()`.
2. Scope all data queries to that `patient_id`.

This means:
- RLS on `appointments`, `treatments`, `payments`, `queue_entries`, and `follow_ups` for the `patient` role must check `patient_id = (SELECT patient_id FROM patient_portal_links WHERE user_id = auth.uid())`.
- A user with no entry in `patient_portal_links` gets zero rows — they are not blocked by an error, they simply see no data.
- `patients.user_id` does not exist. Never add it to the `patients` table.

### Clinics Table

| Field | Type | Notes |
|---|---|---|
| `id` | `uuid` | Primary key |
| `name` | `text` | Clinic display name |
| `phone` | `text` | Clinic contact number |
| `address` | `text` | Physical address |
| `created_at` | `timestamptz` | Auto-set |

---

## 11. Database Schema

### 11.0 Migration Workflow (Supabase CLI)

Schema changes are made **only** through versioned migrations in `supabase/migrations/`.
Editing the hosted database through the Supabase SQL editor is no longer permitted —
it is what produced the duplicate-version and untracked-history problems the CLI
workflow now prevents.

```bash
npm run db:start              # start local Supabase (Docker required)
npm run db:new -- my_change   # create a timestamped migration file
npm run db:reset              # rebuild the local DB from the full history + seed
npm run db:list               # compare local history against the linked remote
npm run db:push               # apply pending migrations to the linked remote
npm run db:lint               # Supabase database linter (RLS, security-definer views…)
npm run db:drill              # dump → restore into a scratch DB → verify (docs/BACKUP-DR.md)
npm run gen:types             # regenerate types/database.types.ts from the local DB
```

### ⚠️ The Playwright suite is RED on main, and has been since `853e188`

`npx playwright test` fails ~60 of its 97 tests. Measured on 2026-09-06 by
running the full suite on a clean checkout of `main` against a freshly reset
database. **This is not a flake and not an environment problem.**

`853e188` replaced `/patient/signup` — the clinic dropdown became the three-step
email/code/password activation — and `e2e/auth.spec.ts` was never updated. Its
`new patient — /patient/signup` and `verification — /patient/verify-email`
blocks still drive the removed dropdown:

```
expect(getByRole('button', { name: 'Create account' })).toBeDisabled()
  → the button no longer starts disabled, because there is no clinic to choose
```

The verify-email tests reach that screen *through* signup, so they fail behind
it, and the parameterised overflow/contrast cases fail on doors they cannot
reach. `e2e/portal-activation.spec.ts` covers the NEW flow and passes.

**Before treating any e2e failure as a regression, diff against `main`.** The P2
work was checked exactly this way — 50 failures on the P2 tree, 60 on clean
`main`, the P2 set a strict subset — which is what established that P2
introduced none of them.

⚙️ **REQUIRES WORK:** rewrite the stale blocks in `e2e/auth.spec.ts` against the
activation flow, or delete them as superseded by `portal-activation.spec.ts`. A
suite everyone expects to be red is a suite nobody reads, and the next real
regression will land in exactly that noise.

Rules:

- **One migration per logical change**, with a unique 14-digit `YYYYMMDDHHMMSS` version.
  Two files sharing a version collide on `schema_migrations.version` (a primary key) and
  one will be silently skipped.
- **Never edit a migration that has already been applied.** Write a new forward migration.
- **`npm run db:reset` before every push.** It rebuilds an empty database from the entire
  history and is the only thing that proves a fresh environment still provisions.
- **Never run `db reset` against a linked remote** — it drops the database, and at least one
  historical migration contains destructive DML.
- Adopting the CLI on a database whose schema was applied by hand requires a one-time
  reconciliation. See **`supabase/REPAIR.md`**.

`supabase/seed.sql` runs on `db reset` only (never on `db push`) and seeds local
sign-in accounts. Clinics are seeded by migration `20260627000000`, so they exist
in every environment.

### 11.1 Canonical Schema

Below is the canonical schema. Always keep migrations in sync with this reference.

> ⚠️ **This section is out of date** (last revised 2026-06-19). It documents 13 tables;
> the database has 18, plus ~33 columns not listed here, and it models enums as
> `text` + CHECK where the database uses native Postgres enums. Treat
> `supabase/migrations/` as authoritative until this section is refreshed.

```sql
-- Clinics
create table clinics (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  phone text,
  address text,
  created_at timestamptz not null default now()
);

-- Profiles (extends Supabase Auth users)
create table profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  clinic_id uuid not null references clinics(id) on delete cascade,
  full_name text not null,
  role text not null check (role in ('dentist', 'receptionist', 'patient')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- Patients
create table patients (
  id uuid primary key default gen_random_uuid(),
  clinic_id uuid not null references clinics(id) on delete cascade,
  name text not null,
  phone text,
  date_of_birth date,
  gender text check (gender in ('male', 'female', 'other')),
  address text,
  emergency_contact_name text,
  emergency_contact_phone text,
  notes text,
  total_visits integer not null default 0,
  last_visit timestamptz,
  deleted_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- Appointments
create table appointments (
  id uuid primary key default gen_random_uuid(),
  clinic_id uuid not null references clinics(id) on delete cascade,
  patient_id uuid not null references patients(id) on delete cascade,
  dentist_id uuid not null references profiles(id),
  scheduled_at timestamptz not null,
  duration_minutes integer not null default 30,
  source text not null check (source in ('walk_in','phone_call','website','referral','other')),
  status text not null default 'scheduled'
    check (status in ('scheduled','checked_in','in_progress','completed','cancelled','no_show')),
  notes text,
  deleted_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- Appointment History (audit trail)
create table appointment_history (
  id uuid primary key default gen_random_uuid(),
  appointment_id uuid not null references appointments(id) on delete cascade,
  action text not null,              -- 'created' | 'rescheduled' | 'cancelled' | 'status_changed'
  old_value jsonb,
  new_value jsonb,
  performed_by uuid references profiles(id),
  timestamp timestamptz not null default now()
);

-- Queue Entries
create table queue_entries (
  id uuid primary key default gen_random_uuid(),
  clinic_id uuid not null references clinics(id) on delete cascade,
  appointment_id uuid not null references appointments(id) on delete cascade,
  patient_id uuid not null references patients(id) on delete cascade,
  position integer not null,
  status text not null default 'waiting'
    check (status in ('waiting','in_progress','completed')),
  checked_in_at timestamptz not null default now(),
  called_at timestamptz
);

-- Treatments
create table treatments (
  id uuid primary key default gen_random_uuid(),
  clinic_id uuid not null references clinics(id) on delete cascade,
  appointment_id uuid not null references appointments(id) on delete cascade,
  patient_id uuid not null references patients(id) on delete cascade,
  treatment_type text not null,
  internal_notes text,              -- visible to dentist only
  patient_visible_notes text,       -- visible in patient portal
  cost numeric(10,2) not null default 0,
  status text not null default 'planned'
    check (status in ('planned','in_progress','completed','cancelled')),
  performed_at timestamptz,
  deleted_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- Payments
create table payments (
  id uuid primary key default gen_random_uuid(),
  clinic_id uuid not null references clinics(id) on delete cascade,
  patient_id uuid not null references patients(id) on delete cascade,
  appointment_id uuid references appointments(id),
  amount numeric(10,2) not null,
  method text not null check (method in ('cash','upi','card','bank_transfer')),
  payment_date date not null default current_date,
  notes text,
  deleted_at timestamptz,
  created_at timestamptz not null default now()
);

-- Follow-Ups
create table follow_ups (
  id uuid primary key default gen_random_uuid(),
  clinic_id uuid not null references clinics(id) on delete cascade,
  patient_id uuid not null references patients(id) on delete cascade,
  appointment_id uuid references appointments(id),
  treatment_id uuid references treatments(id),
  due_date date not null,
  status text not null default 'pending'
    check (status in ('pending','completed','cancelled')),
  notes text,
  deleted_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- Patient Portal Links (decouples patient records from auth accounts)
create table patient_portal_links (
  id uuid primary key default gen_random_uuid(),
  patient_id uuid not null unique references patients(id) on delete cascade,
  user_id uuid not null unique references auth.users(id) on delete cascade,
  created_at timestamptz not null default now()
);

-- Clinic Settings (one-to-one with clinics)
create table clinic_settings (
  clinic_id uuid primary key references clinics(id) on delete cascade,
  clinic_name text not null,
  phone text,
  email text,
  address text,
  clinic_hours jsonb,               -- see Section 5.9 for JSON format
  average_appointment_duration integer not null default 30,
  chair_count integer not null default 1 check (chair_count >= 1),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- Availability Rules
create table availability_rules (
  id uuid primary key default gen_random_uuid(),
  clinic_id uuid not null references clinics(id) on delete cascade,
  day_of_week integer not null check (day_of_week between 0 and 6),
  start_time time not null,
  end_time time not null,
  slot_duration_minutes integer not null default 30,
  is_active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- Webhook Logs
create table webhook_logs (
  id uuid primary key default gen_random_uuid(),
  clinic_id uuid references clinics(id),
  event_type text not null,
  payload jsonb,
  received_at timestamptz not null default now()
);
```

---

## 12. Project Structure

```
dentgrow/
├── app/
│   ├── (auth)/                     # Unauthenticated pages — all render in <AuthShell>
│   │   ├── layout.tsx              # Passthrough; AuthShell owns the full-bleed layout
│   │   ├── login/                  # Staff sign-in (dentist + receptionist)
│   │   ├── patient/
│   │   │   ├── login/              # Patient sign-in
│   │   │   ├── signup/             # New patient registration (clinic selection)
│   │   │   └── verify-email/       # "Check your email" — resend / change address
│   │   ├── admin/
│   │   │   └── login/              # Platform admin sign-in
│   │   ├── signup/                 # Legacy alias → redirects to /patient/signup
│   │   ├── forgot-password/
│   │   └── reset-password/
│   ├── admin/                      # Platform admin console (requireAdmin())
│   │   └── page.tsx
│   ├── (dashboard)/                # Protected app shell
│   │   ├── layout.tsx              # Shared layout with sidebar
│   │   ├── dentist/
│   │   │   ├── page.tsx            # Dentist dashboard
│   │   │   ├── patients/
│   │   │   ├── appointments/
│   │   │   ├── queue/
│   │   │   ├── treatments/
│   │   │   ├── payments/
│   │   │   ├── follow-ups/
│   │   │   ├── analytics/
│   │   │   └── settings/           # Clinic settings management
│   │   └── receptionist/
│   │       ├── page.tsx            # Receptionist dashboard
│   │       ├── patients/
│   │       ├── appointments/
│   │       ├── queue/
│   │       └── payments/
│   ├── portal/                     # Patient portal (separate layout)
│   │   ├── layout.tsx
│   │   ├── page.tsx                # Patient dashboard
│   │   ├── setup/                  # Portal account linking flow
│   │   ├── appointments/
│   │   ├── queue/
│   │   ├── treatments/
│   │   └── payments/
│   └── api/
│       └── webhooks/
│           └── n8n/
│               └── route.ts
├── components/
│   ├── ui/                         # shadcn/ui primitives (auto-generated)
│   ├── auth/                       # Sign-in shell, artwork, and form primitives
│   │   ├── AuthShell.tsx           # Split composition + the three tones
│   │   ├── AuthArtwork.tsx         # Abstract dental-arch canvas
│   │   ├── AuthFields.tsx          # Field, PasswordField, alerts, submit
│   │   └── AuthThemeToggle.tsx
│   ├── shared/                     # Shared cross-role components
│   │   ├── AppointmentCard.tsx
│   │   ├── PatientSearch.tsx
│   │   └── StatusBadge.tsx
│   ├── dentist/                    # Dentist-specific components
│   ├── receptionist/               # Receptionist-specific components
│   ├── patient/                    # Patient portal components
│   ├── queue/                      # Queue management components
│   │   ├── QueueBoard.tsx          # Live queue display
│   │   └── QueueEntry.tsx
│   ├── follow-ups/                 # Follow-up management components
│   │   ├── FollowUpList.tsx
│   │   └── FollowUpForm.tsx
│   ├── analytics/                  # Chart components
│   └── ai/
│       ├── PatientSummaryCard.tsx
│       ├── CopilotChat.tsx
│       ├── InsightsPanel.tsx
│       └── PatientAssistant.tsx    # Patient AI Assistant chat widget
├── lib/
│   ├── supabase/
│   │   ├── server.ts               # createServerClient
│   │   ├── client.ts               # createBrowserClient
│   │   └── middleware.ts           # Session refresh helper
│   ├── ai/
│   │   ├── gemini.ts               # Gemini client initialisation
│   │   ├── prompts.ts              # All prompt templates
│   │   ├── tools.ts                # Copilot tool function definitions
│   │   └── patient-tools.ts        # Patient AI Assistant tool definitions
│   ├── scheduling/
│   │   └── slots.ts                # getAvailableSlots() slot generation logic
│   ├── auth/
│   │   ├── session.ts              # resolveSession(), requireAdmin()
│   │   ├── mfa.ts                  # assurance levels + where MFA is required
│   │   ├── email-mask.ts           # maskEmail() for the verification screen
│   │   └── verification.ts         # resend cooldown + send-failure classification
│   ├── audit/
│   │   └── phi-access.ts           # THE way a sensitive read is recorded
│   ├── staff/
│   │   └── dentist-directory.ts    # the ONLY server-side read of a dentist name
│   ├── security/
│   │   ├── headers.ts              # CSP + the static security headers
│   │   ├── events.ts               # structured security events (no PHI)
│   │   ├── rate-limit.ts           # sign-in lockout + the email-send ceiling
│   │   ├── security-txt.ts         # RFC 9116, or nothing — never a fake address
│   │   ├── file-validation.ts      # magic-byte checks + the scanning seam
│   │   └── timing-safe.ts          # constant-time secret comparison
│   ├── legal/
│   │   └── links.ts                # where the published policy lives
│   ├── data-consent.ts             # data-processing consent vocabulary
│   ├── data-export.ts              # export shape + what may never be in one
│   ├── storage/
│   │   └── signed-urls.ts          # signed-URL lifetimes, and why
│   ├── signatures/
│   │   └── resolve.ts              # private-bucket signature URLs
│   ├── brand/
│   │   └── mark.ts                 # TOOTH_PATH — the logo AND the auth arch
│   └── utils.ts                    # Shared utility functions
├── docs/
│   ├── SECURITY.md                 # controls, with honest status markers
│   ├── DATA-PROTECTION.md          # roles, consent, patient rights
│   ├── AI-DATA-HANDLING.md         # what reaches Google, and what does not
│   ├── RETENTION.md                # what is purged, and what never is
│   ├── OFFBOARDING.md              # why clinic deletion fails, and why that is right
│   ├── BACKUP-DR.md                # backups, restore drill, RPO/RTO
│   ├── INCIDENT-RESPONSE.md        # preserve → contain → scope → notify
│   └── subprocessors.json          # machine-readable third-party inventory
├── actions/
│   ├── patients.ts                 # Patient server actions
│   ├── data-consent.ts             # data-processing consent read/record
│   ├── data-export.ts              # patient record export (returned, not stored)
│   ├── mfa.ts                      # TOTP enrolment + challenge
│   ├── appointments.ts             # Appointment server actions (writes audit history)
│   ├── queue.ts                    # Queue server actions
│   ├── treatments.ts               # Treatment server actions
│   ├── payments.ts                 # Payment server actions
│   ├── follow-ups.ts               # Follow-up server actions
│   ├── clinic-settings.ts          # Clinic settings server actions
│   ├── availability.ts             # Availability rules server actions
│   ├── portal-link.ts              # Patient portal account linking actions
│   └── ai.ts                       # AI feature server actions (all roles)
├── types/
│   └── index.ts                    # All TypeScript types and enums
├── hooks/
│   ├── useQueue.ts                 # Realtime queue subscription
│   └── useRealtimeAppointments.ts
├── middleware.ts                   # Next.js middleware (auth + role routing)
├── .env.local                      # Local environment variables (never commit)
├── scripts/
│   ├── push-auth-email-config.mjs  # Configures the HOSTED project's Auth email
│   ├── restore-drill.mjs           # proves a dump actually restores (npm run db:drill)
│   └── probe-resend-smtp.mjs       # Asks Resend which recipients it will carry
└── supabase/
    ├── EMAIL.md                    # Email transports, limits + the Resend switch
    ├── templates/                  # OraMedha-branded Supabase Auth email bodies
    └── migrations/                 # SQL migration files
```

---

## 13. Development Principles

These are non-negotiable standards. Every PR and every AI-generated code block must conform to these.

### 13.1 Production-Ready Code

- No `console.log` in production paths. Use structured error logging.
- All async operations must have proper error handling (`try/catch` or `.catch()`).
- Loading and error states must be handled in every UI component.
- No hardcoded IDs, magic strings, or raw SQL in application code (use parameterized queries or Supabase query builder only).

### 13.2 Type Safety

- TypeScript strict mode is enabled. No `any` types.
- All database row types must be derived from the Supabase generated types (`database.types.ts`).
- All Server Action inputs must be validated with `zod` before processing.
- All enums (role, status, source, method, gender) must be defined as TypeScript enums or `as const` objects in `types/index.ts` and reused everywhere.

### 13.3 Reusable Components

- Before creating a new component, check if a similar one exists in `components/shared/` or `components/ui/`.
- Components must accept typed props. No prop drilling beyond two levels — use context or server-fetched data instead.
- All form components must use `react-hook-form` with `zod` schema validation.

### 13.4 Server Actions Preferred

- Mutations (create, update, delete) must use Next.js Server Actions defined in the `actions/` directory.
- Server Actions must re-validate the user's `clinic_id` and `role` from the Supabase session. Never trust values from the request body for `clinic_id`.
- Return types from Server Actions must be explicitly typed: `{ data: T | null; error: string | null }`.
- **An exported `"use server"` function is an HTTP endpoint, not dead code.**
  Next.js registers one for every export that reaches the client graph, under a
  stable id, and deleting the UI does not retire it. `signUpPatient` survived
  853e188 that way and stayed browser-dispatchable on all 65 routes as an
  unauthenticated, unthrottled mail-send primitive that accepted a
  browser-supplied `clinic_id`. Delete the action, not just its form —
  `lib/__tests__/server-action-surface.spec.ts` reads the build manifest and
  fails on anything outside the declared set, in both directions.

### 13.5 Mobile Responsive

- All pages and components must be responsive. Use Tailwind's responsive prefixes (`sm:`, `md:`, `lg:`).
- The patient portal must be optimised for mobile-first usage.
- The dentist and receptionist dashboards should be usable on a tablet (768px minimum).

### 13.6 No Mock Data

- Never use hardcoded mock data in components. All data must come from Supabase.
- Use Supabase's local development environment (`supabase start`) for local development.
- Seed scripts may exist in `supabase/seed.sql` for development use only.

### 13.7 Follow Existing Architecture

- New features must follow the established pattern: Server Action in `actions/` → Component in `components/` → Page in `app/`.
- Do not introduce new state management libraries. Use React state, context, and Server Components.
- Do not introduce new HTTP client libraries. Use native `fetch` or Supabase client methods.

### 13.8 Avoid Duplicate Implementations

- Before adding a utility function, check `lib/utils.ts`.
- Before adding a new Supabase query, check if a matching Server Action already exists.
- If a pattern is used in more than two places, extract it into a shared utility or component.

### 13.9 No Secrets or Credential Leaks

- Never commit `.env.local` or any file containing secrets.
- Environment variable names that are safe for the browser must be prefixed with `NEXT_PUBLIC_`.
- AI API keys, Supabase service role keys, and n8n webhook secrets must **never** be prefixed with `NEXT_PUBLIC_` and must only be accessed server-side.
- All secret environment variables must be documented in `.env.example` with placeholder values.

### 13.10 RLS Is the Last Line of Defence

- Application-level role checks (middleware, component guards) are a UX convenience.
- RLS policies are the security guarantee. Every table must have RLS enabled with appropriate policies.
- Never disable RLS on any table containing clinic or patient data.
- **A VIEW must carry `security_invoker = true`.** Without it a view executes
  with its OWNER's privileges, and the owner owns the base tables — so RLS does
  not apply at all. Five views shipped without it and exposed every patient
  record in the database to an unauthenticated caller. `npm run db:lint` is
  `plpgsql_check`, a function-body linter, and cannot see this class of defect;
  the rule that catches it is Supabase's `0010_security_definer_view` in the
  hosted Security Advisor.
- **An audit table gets no client write policy at all.** Under RLS the absence
  of a policy is a denial. Writes go through the service role, and an
  append-only trigger constrains that too — `service_role` carries `BYPASSRLS`,
  so no policy can bind it.
- **A policy with no ROLE predicate widens itself when a new role gains rows.**
  `profiles: read own clinic members` was `using (clinic_id = auth_clinic_id())`
  and was correct when only staff had a `profiles` row. Portal patients later
  got one, and without anyone touching the policy it began handing every
  activated patient the full staff roster — auth user ids, `role`, `is_admin`,
  `signature_url` — plus the names of the clinic's other portal patients. Fixed
  in `20260905090000`. The rule: **a policy scoped only by tenant is a policy
  that will be wrong the day a new role joins the tenant.** Say who, not just
  where.
- **Also: RLS cannot restrict COLUMNS, and column GRANTs are per database role
  (`authenticated`), not per user.** So when one audience legitimately needs a
  narrow slice of a table another must not see, the answer is not a cleverer
  policy — it is a server-side projection over ids the caller is already
  entitled to. See `lib/staff/dentist-directory.ts`, which is exactly that for
  the dentist's name on a patient's own prescription.
- **Put a function's authorisation in the function.** If it is only safe because
  of a policy on another object, that safety survives by luck. And RLS does not
  bind `service_role` — `bulk_decrement_queue_positions` would have decremented
  queue positions across every clinic under an accidental service-role call
  until `20260905090100` gave it its own `clinic_id` predicate.
- **A `WITH CHECK` clause that only restates the `USING` clause pins nothing.**
  `profiles`, `patients` AND `appointments` each shipped an UPDATE policy
  asserting only a column the attacker never changes. Pin the identity-bearing
  columns against their pre-update values, read through a `stable security
  definer` helper.
- **Pin by DENY-list, not allow-list.** `20260903000100` named the nine columns
  the portal may not change on `patients`. `20260904184013` added `email` the
  next day and did not add it to the pin, so the list was stale within
  twenty-four hours. `20260907000000` compares
  `to_jsonb(row) - <the columns that may change>` against the pre-update row
  instead, so a column added later is frozen by default. Name what may move.
- **RLS cannot restrict columns, and a table-level GRANT subsumes column
  grants.** So `revoke select (col)` is a no-op until the table grant is
  revoked and re-granted per column — after which `SELECT *` fails for every
  role, including the one you meant to keep. That is the price of column
  security in Postgres and it is worth paying for clinical free-text:
  `20260907000100` withholds `treatments.internal_notes` and the appointment
  assessment columns, and staff read them through SECURITY DEFINER projections
  scoped by clinic AND role. See `lib/appointments/data-api-columns.ts`.
- **A SECURITY DEFINER view is not automatically the 20260902155414 defect.**
  Those five views had NO predicate of their own, which is why an anonymous
  caller read every row. A definer view that carries its authorisation in its
  own `WHERE` clause is the "server-side projection" this section already
  prescribes. The distinction is testable, which is why
  `view-security-invoker.spec.ts` asserts BEHAVIOUR rather than the catalog
  flag — keep it that way.

### 13.11 AI Must Never Block Core Operations

- All AI features (Patient Summary, Copilot, Insights, Patient AI Assistant) must be wrapped in `try/catch` and render non-blocking fallback UI on failure.
- Core modules — Patients, Appointments, Queue, Treatments, Payments, Analytics — must function completely independently of Gemini availability.
- Never make a page render contingent on an AI response.
- AI calls must have a defined timeout (recommended: 10 seconds). On timeout, display the fallback message and log the error.

### 13.12 AI Action Confirmation Required

- AI systems (Clinic Copilot and Patient AI Assistant) must **never** execute a mutating operation without explicit user confirmation.
- This applies to: appointment booking, appointment cancellation, appointment rescheduling, payment updates, and follow-up creation.
- The required pattern: AI presents the proposed action with all relevant details → user confirms → Server Action executes.
- The model must not call a mutating tool function in the same turn it identifies the intent. Confirmation is a mandatory intermediate step.
- UI must make it unambiguous what the user is confirming (e.g., a confirmation card with slot details and a "Confirm Booking" button).

### 13.13 AI Models Must Never Access Data Directly

- AI models (Gemini) must never execute SQL, call Supabase directly, or hold or receive database credentials.
- All data access by AI features must occur through typed tool functions defined in `lib/ai/tools.ts` or `lib/ai/patient-tools.ts`.
- Tool functions are executed server-side by the application, not by the model.
- Tool function inputs received from the model must be validated with `zod` before any database call is made.
- The model receives only the structured result of the tool call — never raw database responses, connection strings, or credentials.

### 13.14 Soft Delete Enforcement

- Every Server Action that queries soft-deletable tables (`patients`, `appointments`, `treatments`, `payments`, `follow_ups`, `treatment_documents`) must include a `deleted_at IS NULL` filter.
- The `active_*` views apply this filter automatically. **They are safe to use
  again**: all five were created without `security_invoker = true`, which made
  them execute as their owner and bypass RLS entirely — every patient record in
  the database was readable, modifiable and deletable by an unauthenticated
  caller holding only the public anon key. Fixed in `20260902155414`.
  `active_treatments` and `active_appointments` were narrowed again in
  `20260907000100`: they no longer project the clinical columns, which are
  withheld from `authenticated` at the column level, and a view that selects one
  fails for every caller.
  `actions/__tests__/view-security-invoker.spec.ts` sweeps **every** view in
  `public` and asserts the behaviour rather than the catalog option.
  **ADD A ROW TO THAT SPEC WHENEVER YOU ADD A VIEW.**
- Soft deletes must be performed via a dedicated Server Action that sets `deleted_at = now()` — never via a raw `DELETE` statement.
- RLS policies for all roles must include `deleted_at IS NULL` for standard read policies.

---

## 14. Non-Goals for MVP

The following features are explicitly **out of scope** for the MVP. Do not implement, scaffold, or stub these unless a future spec explicitly re-introduces them.

| Feature | Reason Excluded |
|---|---|
| WhatsApp Integration | Requires additional vendor approval and compliance review. Allow-listed to development clinics; the send path now honours withdrawn `communications` consent, but the allow-list itself remains in force. |
| Voice AI | Significant infrastructure complexity; not validated with users |
| Inventory Management | Different user workflow; separate product scope |
| Billing / Invoice Generation | PDF generation and accounting integration deferred |
| Multi-Clinic Chains | Requires org-level tenant hierarchy above `clinics` table |
| Advanced RAG | Embeddings and vector search infrastructure not yet provisioned |

If a future request asks for any of the above, flag it explicitly rather than quietly implementing it.

---

## 15. Environment Variables

All environment variables are documented here. Store actual values in `.env.local` (never committed). Use `.env.example` as the committed reference.

```bash
# .env.example

# Supabase
NEXT_PUBLIC_SUPABASE_URL=https://your-project.supabase.co
NEXT_PUBLIC_SUPABASE_ANON_KEY=your-anon-key
SUPABASE_SERVICE_ROLE_KEY=your-service-role-key   # Server-side only

# Google AI (Gemini)
GOOGLE_AI_API_KEY=your-gemini-api-key             # Server-side only

# n8n Webhook
N8N_WEBHOOK_SECRET=your-shared-secret             # Server-side only
N8N_BASE_URL=https://your-n8n-instance.com        # Server-side only

# App
NEXT_PUBLIC_APP_URL=http://localhost:3000

# Published legal documents — the marketing site holds the canonical Privacy
# Policy; this app links out to it (lib/legal/links.ts). Defaults to
# https://oramedha.com when unset. NEXT_PUBLIC_TERMS_URL is deliberately unset:
# no Terms page is published, and the sign-in footer omits the clause rather
# than linking to a 404.
# NEXT_PUBLIC_MARKETING_URL=https://oramedha.com
# NEXT_PUBLIC_TERMS_URL=https://oramedha.com/terms

# Content-Security-Policy: report-only unless set to "enforce". Flip only after
# verifying a real deployment reports no violations. See docs/SECURITY.md.
# CSP_MODE=enforce

# Security contact published at /.well-known/security.txt (RFC 9116). UNSET, and
# the route 404s while it is — deliberately. A security.txt naming a mailbox
# nobody reads is worse than none: the researcher who finds it stops looking for
# another way to reach you. Use a SHARED address, not a person's.
# SECURITY_CONTACT=security@oramedha.com
# SECURITY_POLICY_URL=https://oramedha.com/security

# Require the platform admin to have two-step verification. OFF by default, and
# the default is load-bearing: turning it on before the admin has enrolled locks
# that account out of the console it would use to fix it.
# REQUIRE_ADMIN_MFA=true

# Auth email delivery — NOT read by the app. Used only by
# `npm run auth:email:push`, which configures the HOSTED Supabase project.
# Local development sends to Mailpit and needs none of these.
# See supabase/EMAIL.md.
AUTH_SITE_URL=https://your-domain.com
SUPABASE_ACCESS_TOKEN=sbp_personal_access_token   # Server-side only
SUPABASE_PROJECT_REF=your-project-ref

# Resend — unset today, so the push script selects Supabase's built-in service.
# Fill in only once a sending domain is verified in Resend.
# RESEND_SMTP_PASSWORD=re_your_resend_api_key     # Server-side only
# AUTH_SMTP_SENDER_EMAIL=no-reply@auth.your-domain.com
# AUTH_SMTP_SENDER_NAME=OraMedha
```

### Usage Rules

| Variable | Where Used | Client Safe? |
|---|---|---|
| `NEXT_PUBLIC_SUPABASE_URL` | Supabase client init | Yes |
| `NEXT_PUBLIC_SUPABASE_ANON_KEY` | Supabase browser client | Yes |
| `SUPABASE_SERVICE_ROLE_KEY` | Server Actions, admin operations | **No** |
| `GOOGLE_AI_API_KEY` | AI Server Actions only | **No** |
| `N8N_WEBHOOK_SECRET` | Webhook route handler only | **No** |
| `N8N_BASE_URL` | n8n trigger calls only | **No** |
| `NEXT_PUBLIC_APP_URL` | Absolute URL generation | Yes |
| `NEXT_PUBLIC_MARKETING_URL` | Legal-document links on sign-in pages | Yes |
| `NEXT_PUBLIC_TERMS_URL` | Terms link, once Terms are published | Yes |
| `CSP_MODE` | CSP enforcement (`lib/security/headers.ts`) | **No** |
| `SECURITY_CONTACT` | `/.well-known/security.txt` — omit and it 404s | **No** |
| `SECURITY_POLICY_URL` | optional `Policy:` line in security.txt | **No** |
| `REQUIRE_ADMIN_MFA` | Mandatory admin two-step verification | **No** |
| `RESEND_SMTP_PASSWORD` | `npm run auth:email:push -- --provider=resend` | **No** |
| `SUPABASE_ACCESS_TOKEN` | `npm run auth:email:push` only | **No** |
| `AUTH_SMTP_SENDER_EMAIL` | `npm run auth:email:push` only | **No** |
| `AUTH_SITE_URL` | `npm run auth:email:push` only | **No** |
| `SUPABASE_PROJECT_REF` | `npm run auth:email:push` only | **No** |

---

## 16. Future Scalability Notes

The current architecture is intentionally designed to support the following additions without requiring major schema redesigns. When building any feature, keep these future paths in mind and avoid decisions that would close them off.

| Future Capability | Current Design Decision That Enables It |
|---|---|
| WhatsApp / SMS automation | `clinic_settings` stores contact info; n8n webhook infrastructure already in place |
| Email reminders | `clinic_settings.email` field; n8n workflow slots pre-defined |
| Multi-dentist scheduling | `availability_rules` has a `clinic_id` column; adding `dentist_id` is additive. `appointments.dentist_id` already exists. |
| Multiple treatment rooms | Room can be added to `availability_rules` and `appointments` as an additive column |
| AI-powered recall campaigns | `follow_ups` table provides the data foundation; n8n + Gemini can orchestrate outreach |
| Patient self-registration at scale | `patient_portal_links` decouples auth from patient records; matching logic is isolated in `actions/portal-link.ts` |
| Clinic FAQ customisation | `clinic_settings` stores all clinic info; prompts read from the database, not hardcoded |
| Advanced analytics / BI | All data is structured and clinic-scoped; adding a read replica or analytics view is non-breaking |

**Principles for future-proof development:**
- Add columns rather than changing existing ones when extending entities.
- Use additive migrations only — never drop or rename columns without a deprecation cycle.
- Keep business logic in Server Actions, not in database triggers, so logic is portable.
- Do not hardcode clinic-specific values (phone, hours, name) anywhere in the codebase — always read from `clinic_settings`.

---

## Appendix: Key Type Definitions

```typescript
// types/index.ts

export type UserRole = 'dentist' | 'receptionist' | 'patient'

export type AppointmentStatus =
  | 'scheduled'
  | 'checked_in'
  | 'in_progress'
  | 'completed'
  | 'cancelled'
  | 'no_show'

export type AppointmentSource =
  | 'walk_in'
  | 'phone_call'
  | 'website'
  | 'referral'
  | 'other'

export type TreatmentStatus = 'planned' | 'in_progress' | 'completed' | 'cancelled'

export type PaymentMethod = 'cash' | 'upi' | 'card' | 'bank_transfer'

export type QueueStatus = 'waiting' | 'in_progress' | 'completed'

export type Gender = 'male' | 'female' | 'other'

export type FollowUpStatus = 'pending' | 'completed' | 'cancelled'

export type AppointmentHistoryAction =
  | 'created'
  | 'rescheduled'
  | 'cancelled'
  | 'status_changed'

// Patient AI Assistant tool names
export type PatientAssistantTool =
  | 'getAvailableSlots'
  | 'createAppointment'
  | 'rescheduleAppointment'
  | 'cancelAppointment'
  | 'getQueueStatus'
  | 'getPatientAppointments'
  | 'getPatientTreatments'
  | 'getPatientPayments'
  | 'getClinicInformation'

// Clinic hours shape (stored as JSONB in clinic_settings)
export type DayHours = {
  open: string | null    // e.g. "09:00"
  close: string | null   // e.g. "18:00"
  is_open: boolean
}

export type ClinicHours = Record<
  'monday' | 'tuesday' | 'wednesday' | 'thursday' | 'friday' | 'saturday' | 'sunday',
  DayHours
>

// Available slot shape returned by getAvailableSlots()
export type AvailableSlot = {
  start_time: string      // ISO 8601 datetime
  end_time: string        // ISO 8601 datetime
  duration_minutes: number
}

// Standard server action return shape
export type ActionResult<T> = {
  data: T | null
  error: string | null
}
```

---

*This document is the authoritative reference for OraMedha. When in doubt about architecture, features, or scope — consult this file first. Update it whenever a significant architectural decision is made.*

*For security, privacy and data-handling specifics — what is implemented, what
is partial, what needs a dashboard toggle, and what needs a lawyer — see the
`docs/` directory. Those documents mark every claim, and they say what is NOT
done as plainly as what is.*
