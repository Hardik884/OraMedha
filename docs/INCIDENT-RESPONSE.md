# Incident response

**A working procedure for a small team. It is not a legal document and it does
not state anyone's statutory obligations.**

⚖️ **Reporting duties, deadlines and who must be notified are legal questions.
This document deliberately does not answer them.** Establish them with counsel
*before* an incident, because the point at which you need the answer is the
point at which you have no time to find it.

---

## 1. Detection — the honest position

Most of what would tell you something is wrong is **⚙️ not yet configured**.
The code emits the signals; nothing is watching them.

| Signal | Emitted? | Watched? |
|---|---|---|
| Failed sign-ins, lockouts | ✅ `AUTH_FAILED`, `AUTH_LOCKED_OUT` | ❌ |
| Correct password at the admin door | ✅ `AUTH_WRONG_AUDIENCE` | ❌ |
| Non-admin reaching `/admin` | ✅ `ADMIN_ACCESS_DENIED` | ❌ |
| Cross-tenant attempt | ✅ `TENANT_BOUNDARY_REFUSED` | ❌ |
| Identifier or secret in an AI prompt | ✅ `AI_PROMPT_WITHHELD` | ❌ |
| MFA removed | ✅ `MFA_UNENROLLED` | ❌ |
| Unusual volume of PHI reads | ✅ `phi_access_log` | ❌ |
| Anon-role reads of PHI relations | Supabase logs | ❌ |

⚙️ **FIRST ACTION, before anything else in this document is useful:** configure
a log drain from Vercel and Supabase, and alert on the `[security]` prefix. The
rules are listed in `docs/SECURITY.md` §4.

---

## 2. When something happens

### Step 1 — Preserve, before you fix

**Logs rotate.** Whatever window you have is shrinking while you read this.

- Export Supabase Auth, Postgres and Storage logs for the period **now**.
- Export Vercel function logs for the period.
- Snapshot `phi_access_log` for the window:
  ```sql
  select * from phi_access_log
   where occurred_at between $start and $end
   order by occurred_at;
  ```
- Note the current time and who noticed.

Do this **before** rotating keys — rotation can end sessions you would have
wanted to inspect.

### Step 2 — Contain

Choose the smallest action that stops the bleeding:

| Situation | Action |
|---|---|
| A credential has leaked | Rotate it (§3) |
| One account is compromised | Sign it out everywhere, force a password reset, remove its MFA factor and re-enrol |
| A database read path is exposed | `revoke` the privilege — do not wait for a code deploy |
| A storage object is exposed | The buckets are private; a leaked signed URL expires in 5 minutes (1 hour for signatures) |
| The application itself is the problem | Roll back the Vercel deployment |

### Step 3 — Scope it

**This is what `phi_access_log` exists for.** Before it existed, the honest
answer to "what was accessed" was *unknown*.

```sql
-- Everything one actor read in a window
select event, resource_type, resource_id, patient_id, occurred_at
  from phi_access_log
 where actor_id = $actor and occurred_at between $start and $end
 order by occurred_at;

-- Everyone who read one patient's record
select actor_id, actor_role, event, occurred_at
  from phi_access_log
 where patient_id = $patient
 order by occurred_at desc;

-- Refused access — repeated denials are what an intrusion looks like
select * from phi_access_log
 where allowed = false and occurred_at > now() - interval '7 days';
```

**Limits, stated so nobody over-reads the result:** the log covers reads through
the application. It does not cover direct PostgREST access with a stolen key,
direct database connections, or the platform's own access. For those, Supabase's
own logs are the source — which is why Step 1 comes first.

### Step 4 — Assess

Answer, in writing:

1. What data, in what categories, for how many people?
2. Which clinics?
3. Was it read, modified, or only exposed?
4. When did it start, and when did it stop?
5. Is it still happening?

### Step 5 — Notify

⚖️ **Who, when and in what form are legal questions.** What is technically true:

- Each **clinic** is the party with the direct relationship to its patients.
- OraMedha processes on the clinic's behalf and is the only party that can
  determine technical scope.
- Notifying a clinic is not optional in practice regardless of the legal
  analysis: they cannot act on something they have not been told.

### Step 6 — Afterwards

Write down what happened, what was done, and **what would have detected it
sooner**. That last one is the only part that changes the next incident.

---

## 3. Rotating credentials

| Credential | Where | Effect |
|---|---|---|
| `SUPABASE_SERVICE_ROLE_KEY` | Supabase → Project Settings → API | **Rotating invalidates the old key immediately.** Update Vercel first, then rotate, or the app breaks between the two. |
| `NEXT_PUBLIC_SUPABASE_ANON_KEY` | Same | Ends every browser session — everyone signs in again. |
| `GOOGLE_AI_API_KEY` | Google AI Studio | AI features fail gracefully until updated. Nothing clinical breaks. |
| `CRON_SECRET` | Vercel env **and** Supabase Vault | Must be changed in **both** — the endpoints fail closed, so a mismatch silently stops the scheduled jobs. |
| A user's password | Supabase Auth admin | Sessions persist until they expire; sign the user out explicitly as well. |

---

## 4. The production dump on a developer machine

A prior audit reported `backup-pre-cli-data.sql` (~201 KB) on a developer
machine, containing `auth.users` (password hashes), `auth.refresh_tokens`,
`auth.sessions`, and every patient, treatment and payment row.

**What is confirmed from this repository:**

- ✅ It is **not** tracked, and has **never** been committed — verified across
  all refs and all history.
- ✅ `.gitignore` covers `backup*.sql`, `supabase/backup*.sql`, `*.dump`,
  `*.sql.gz`, `*.backup` and `pg_dump*`.
- ✅ No such file exists in this checkout.

**What cannot be done from here, and must be done by hand:**

1. Locate every copy on every developer machine — including Downloads, Desktop,
   Trash, Time Machine / File History snapshots, and any cloud-synced folder
   (Dropbox, iCloud, OneDrive) it may have been inside.
2. Delete them securely.
3. Check whether it was ever attached to a chat, an email or a support ticket.
   A copy in a message thread is a copy in someone else's backups.
4. **Treat every credential in it as compromised.** It contains password hashes
   and refresh tokens: rotate the anon and service-role keys, and require a
   password reset for any account whose hash was in it.
5. Record what was found, where, and what was done — including "no other copies
   found", which is itself a finding.

**Do not take a fresh production dump to a laptop.** If production data is
genuinely needed for debugging, restore into a scratch Supabase project
(`docs/BACKUP-DR.md` §4) and delete it afterwards.

---

## 5. Roles

⚙️ **REQUIRES MANUAL COMPLETION.** These are unfilled on purpose — inventing
names here would be worse than a blank.

| Role | Who | Reachable how |
|---|---|---|
| Incident lead | *(unassigned)* | |
| Technical responder | *(unassigned)* | |
| Clinic contact | *(unassigned)* | |
| Legal counsel | *(unassigned)* | |
| **Inbound security reports** | *(unassigned)* | published at `/.well-known/security.txt` once `SECURITY_CONTACT` is set |

A single named person who can be reached out of hours matters more than the
structure of this table.

The last row is different from the others in one way worth noting: it is the
only one an **outsider** uses. The rest of this table is for reaching each other
once an incident is known about. That row is how someone tells you there is one
— and until it is filled in, `/.well-known/security.txt` returns 404 and a
researcher who found a way into a clinic's data has no published route to report
it. See `lib/security/security-txt.ts` for why serving a placeholder address
instead would be worse than the 404.
