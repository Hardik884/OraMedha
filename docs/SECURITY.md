# Security — what is implemented, and what is not

**Scope:** the OraMedha practice-management application (this repository).
The marketing site is a separate application with a separate posture.

Every item is marked with one of:

| Marker | Meaning |
|---|---|
| ✅ **IMPLEMENTED** | In the codebase, tested, and effective without further action. |
| 🟨 **PARTIALLY IMPLEMENTED** | Real and working, with a stated limit. |
| ⚙️ **REQUIRES MANUAL CONFIGURATION** | Code is ready; a dashboard, env var or schedule is not. |
| ⚖️ **REQUIRES LEGAL / PROVIDER ACTION** | Nothing in code can close this. |

This document describes engineering controls. It is **not** a compliance
attestation and makes no claim about DPDP, SPDI, HIPAA, ISO 27001 or SOC 2.

---

## 1. Tenant isolation

✅ **IMPLEMENTED.** Row Level Security on every table, rooted in
`auth_clinic_id()`, `auth_role()` and `auth_patient_id()` — all
`stable security definer` helpers that read the caller's own `profiles` row.
Nothing about identity comes from the browser.

✅ The five soft-delete views that bypassed RLS were fixed in
`20260902155414`, and `actions/__tests__/view-security-invoker.spec.ts` sweeps
**every** view in `public`, asserting anon reads nothing and each view agrees
with its base table per caller. **Add a row to that spec's `VIEWS` list
whenever a view is added.**

✅ The patient-portal `UPDATE` policy on `patients` now pins `clinic_id` and
every clinical field (`20260903000100`). Before that, a portal account holding
only the public anon key could move its own record into another clinic and
rewrite the clinician's notes.

🟨 **FORCE ROW LEVEL SECURITY is not enabled.** It is genuine defence in depth
against the whole class of defect the views represented, and it also subjects
the table *owner* to RLS — which affects migration-time DML and `supabase/seed.sql`.
It needs its own migration and its own review. Not done here.

⚙️ `npm run db:lint` is `plpgsql_check`, a **function-body** linter. It cannot
see a view without `security_invoker` and never could. The rule that catches
that class is Supabase's database linter `0010_security_definer_view`, which
runs in the hosted **Security Advisor**. Wire
`supabase db advisors --linked --type security` into CI.

---

## 2. Authentication

✅ Three audience-separated sign-in doors. Role, `clinic_id` and `is_admin` are
read server-side from `profiles` after the password check; an account arriving
at the wrong door is refused and signed straight back out.

✅ **Per-account lockout** (`lib/security/rate-limit.ts`): 8 failures in 15
minutes locks an identifier for 15 minutes. Supabase Auth limits per IP; this
is the limit an attacker spreading attempts across many IPs still hits.

🟨 It is **in-process**. On serverless each warm instance keeps its own counter,
so the effective limit is per instance, and a restart clears it. A shared store
(Redis, or a Postgres table) is the upgrade. This is stated in the module rather
than left to be discovered.

✅ **TOTP two-step verification**, enrolled from Clinic Settings. Anyone who has
enrolled is challenged on every sign-in, enforced in middleware so navigating
away from `/mfa` does not skip it.

⚙️ **The hosted project has its own MFA setting.** `supabase/config.toml`
governs the local stack only. Enable TOTP in the dashboard under
Authentication → Multi-Factor.

⚙️ **`REQUIRE_ADMIN_MFA` is off.** Turning it on before the admin account has
enrolled locks that account out of the console it would use to fix the problem.
Sequence: enrol at `/dentist/settings` → confirm sign-in works → set the flag.

⚙️ **Leaked-password protection** (HaveIBeenPwned) is a dashboard toggle under
Authentication → Policies. Not enabled.

✅ **Per-address send ceiling** (`consumeSendQuota`, same module): 3 sends per
address per 10 minutes on the two unauthenticated actions that make the server
email somebody — `requestActivation` (portal) and `requestPasswordReset` (all
audiences).

The sign-in lockout did not cover these. It counts *failed* password attempts,
and every request to those two succeeds — the send **is** the cost, not the
failure. Without a ceiling, either endpoint delivers repeated mail to an address
the caller names, and exhausts the clinic's shared provider allowance, after
which no real patient can activate and no real dentist can reset a password.

The quota is consumed **before** the address is checked for existence, so an
unknown address burns allowance exactly like a known one. Otherwise the throttle
itself would answer the question the deliberately generic responses refuse to.

🟨 Same in-process caveat as the lockout above. Supabase Auth's own per-hour
mailer limit is the distributed layer underneath; this adds the per-address
ceiling that layer does not have.

⚙️ **CAPTCHA / bot protection** is configurable in `supabase/config.toml`
(`[auth.captcha]`) and needs an hCaptcha or Turnstile account. **Not configured,
and not currently recommended.** The public surface is five pages — three
sign-in doors, forgot-password, and portal activation — and each is now behind
either the per-account lockout or the send ceiling. There is no public contact
or demo form (`NewInquiryModal` renders for staff only), and every API route is
secret-gated. Revisit if real abuse appears in the logs; adding a third-party
script and an account to defend a surface already covered would cost every
honest user a challenge to buy nothing.

---

## 3. HTTP security headers

✅ HSTS (2 years, subdomains, preload), `X-Content-Type-Options: nosniff`,
`X-Frame-Options: DENY`, `Referrer-Policy: strict-origin-when-cross-origin`,
`Permissions-Policy` denying camera/microphone/geolocation/payment/USB, and
`Cross-Origin-Opener-Policy: same-origin`. Served for every route from
`next.config.ts`; asserted by `lib/security/__tests__/headers.spec.ts`.

Referrer-Policy earns its place here specifically: clinical URLs embed patient
and treatment UUIDs, and a permissive policy puts record identifiers in a header
sent to other origins.

🟨 **Content-Security-Policy is REPORT-ONLY by default.** Nonce-based, so
`script-src` needs no `'unsafe-inline'`. It reports rather than enforces because
a CSP that blocks something real does not degrade — it breaks the page in the
browser after deploy, and this app renders Supabase signed URLs as images,
prints consent documents through `blob:` iframes, stores signatures as `data:`
URLs, and drives the live queue over a websocket.

⚙️ **Set `CSP_MODE=enforce` after verifying a deployment.** Exercise sign-in, a
patient profile, an X-ray preview, a consent print and the portal assistant, and
confirm the browser console reports no violations. Then flip it.

---

## 4. Audit logging

✅ **PHI read access** (`phi_access_log`, `20260903000000`). Records who read
which record, when, in what role. Identifiers only — never names, phone numbers,
clinical content, amounts, search terms, prompts or credentials. The `context`
column is filtered through an allow-list in `lib/audit/phi-access.ts`, so
`{ patientName }` cannot be written even by accident.

Immutable by two independent mechanisms: RLS gives a dentist read access to
their own clinic's trail and gives *nobody* a write policy; and a trigger blocks
`UPDATE` outright and `DELETE` outside a declared retention purge. The trigger is
what binds the **service role**, which RLS cannot — `service_role` carries
`BYPASSRLS`.

✅ **Write trails**: `appointment_history`, `consent_audit`, `tooth_history`,
and now `treatment_history` (`20260903000300`).

✅ **Security events** (`lib/security/events.ts`): single-line JSON with a
stable `[security]` prefix, on stdout, which the platform already collects.
Emails are hashed rather than logged.

⚙️ **Nothing alerts.** A log drain and alert rules are infrastructure, not code.
Events worth alerting on:

| Event | Suggested rule |
|---|---|
| `AUTH_LOCKED_OUT` | > 5 distinct subjects in 10 min |
| `AUTH_WRONG_AUDIENCE` (surface `admin`) | any occurrence |
| `ADMIN_ACCESS_DENIED` | any occurrence |
| `TENANT_BOUNDARY_REFUSED` | any occurrence — page someone |
| `AI_PROMPT_WITHHELD` | any occurrence — this is a code defect |
| `MFA_UNENROLLED` | any occurrence |
| Anon-role reads of PHI relations (Supabase logs) | any occurrence |

---

## 5. Storage

✅ All three buckets are **private**. `dentist-signatures` was public until
`20260903000400`; it held a dentist's handwritten signature — the mark that
authenticates a prescription — behind a permanent, world-readable URL that was
rendered into patient-facing HTML.

✅ Signed URLs: **300s** for patient documents and consents; **3600s** for
signatures, because they are rendered into invoices and consents printed to PDF
client-side minutes after page load. The difference is deliberate and documented
in `lib/signatures/resolve.ts`.

✅ **Upload content validation** (`lib/security/file-validation.ts`): the
leading bytes are checked against the format's magic number, and the
`Content-Type` stored on the object comes from the bytes rather than the
browser's claim.

🟨 **No malware scanning.** `scanUpload()` returns `not-scanned`, never
`clean` — a stub reporting clean would let a reader believe uploads are scanned
when nothing is scanning them. Adding a scanner is one implementation behind
that seam.

---

## 6. AI

See `docs/AI-DATA-HANDLING.md`. Summary: identifiers are stripped, every
outbound prompt passes a guard that rejects secrets outright, and there is
still no DPA, no established retention position and no regional control.

---

## 7. Secrets

✅ No secret has been committed; `.gitignore` covers `.env*`, `backup*.sql`,
`*.dump`, `*.sql.gz` and `pg_dump*`. Service-role and AI keys are server-only
and never prefixed `NEXT_PUBLIC_`.

⚖️ **A production `pg_dump` was reported on a developer machine**
(`backup-pre-cli-data.sql`, containing `auth.users` password hashes,
`auth.refresh_tokens`, and every patient row). It is correctly gitignored and is
**not** in this repository or its history — verified across all refs. It cannot
be remediated from here. See `docs/INCIDENT-RESPONSE.md` §4.

---

## 8. Vulnerability reporting

⚙️ **There is no published security contact, and `/.well-known/security.txt`
returns 404 because of it.**

The route exists (`app/.well-known/security.txt/route.ts`) and serves a valid
RFC 9116 file the moment `SECURITY_CONTACT` names a real address. Until then it
serves nothing, deliberately: the RFC makes `Contact` mandatory, and a
security.txt naming a mailbox nobody reads is worse than no file at all — a
researcher who finds one stops looking for another way to reach us and reports
into a void.

The path is public by design; `/.well-known` is exempted in
`lib/supabase/middleware.ts`, because the file's entire audience is people with
no account, and redirecting them to `/login` is the same as not publishing.

→ **To close this:** choose a monitored SHARED mailbox (not a person's, so it
survives them leaving), set `SECURITY_CONTACT`, and fill in the inbound-reports
row in `docs/INCIDENT-RESPONSE.md`.

---

## 9. What is deliberately NOT claimed

- No compliance certification of any kind.
- No claim that data is stored in any particular country — the regions are
  unverified, and `docs/subprocessors.json` says so.
- No claim that Google does not retain or train on AI prompts.
- **No claim that the platform backups have been restore-tested.** They have
  not. `npm run db:drill` proves the *mechanism* — that a dump of this schema
  restores intact, with the append-only triggers still attached — against local
  seed data. It says nothing about Supabase's own backups or about Storage
  objects. `docs/BACKUP-DR.md` §4a is explicit about the boundary.
- No claim that there is a route for a security researcher to reach us. See §8.
