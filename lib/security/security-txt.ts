/**
 * lib/security/security-txt.ts
 *
 * The body of /.well-known/security.txt (RFC 9116), or null.
 *
 * WHY IT CAN BE NULL
 *   RFC 9116 makes `Contact` and `Expires` mandatory (sections 2.5.3 and
 *   2.5.5). A file without a working contact is not a lesser security.txt — it
 *   is a worse outcome than having none, because a researcher who finds one
 *   stops looking for another route and reports into a void.
 *
 *   OraMedha has no security contact today. docs/INCIDENT-RESPONSE.md records
 *   the role as *(unassigned)*, and nothing in this repository, the marketing
 *   site or the app publishes an address for reporting a vulnerability. So this
 *   returns null until one is configured, the route 404s, and the gap stays
 *   visible instead of being papered over with an address somebody guessed.
 *
 *   This is the same rule lib/legal/links.ts applies to the Terms URL: refuse
 *   to invent, return null, let the caller omit it.
 *
 * → REQUIRES AN OPERATIONAL DECISION: choose a monitored address (a shared
 *   mailbox, not a person's, so it survives them leaving), set
 *   SECURITY_CONTACT, and fill in the contact row in
 *   docs/INCIDENT-RESPONSE.md. See docs/SECURITY.md.
 *
 * WHY `Expires` IS COMPUTED
 *   RFC 9116 recommends less than a year out, and an expired file is one a
 *   researcher may disregard entirely. A date written into a static file goes
 *   stale silently the moment nobody remembers to edit it — which, for a file
 *   touched once at setup, is immediately. Deriving it from the request keeps
 *   it always valid without anybody maintaining it.
 */

/** How far ahead `Expires` is set. Under RFC 9116's one-year recommendation. */
const EXPIRY_DAYS = 180;

/**
 * A contact usable in a `Contact:` field.
 *
 * Accepts a bare address (turned into `mailto:`) or an absolute https URL — the
 * two forms the RFC names. Anything else is rejected rather than emitted, so a
 * half-filled environment variable produces no file instead of a malformed one.
 */
function normaliseContact(raw: string | undefined): string | null {
  const value = (raw ?? "").trim();
  if (!value) return null;

  if (value.startsWith("https://")) return value;
  if (value.startsWith("mailto:")) {
    return /^mailto:[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value) ? value : null;
  }
  if (/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value)) return `mailto:${value}`;

  // http://, a relative path, a phone number, a sentence — none are valid here.
  return null;
}

/** Optional, and omitted rather than guessed when unset. */
function normalisePolicyUrl(raw: string | undefined): string | null {
  const value = (raw ?? "").trim();
  return value.startsWith("https://") ? value : null;
}

/**
 * The file body, or null when no usable contact is configured.
 *
 * @param now injectable so the spec can assert the Expires field deterministically.
 */
export function securityTxt(now: Date = new Date()): string | null {
  const contact = normaliseContact(process.env.SECURITY_CONTACT);
  if (!contact) return null;

  const expires = new Date(now.getTime() + EXPIRY_DAYS * 24 * 60 * 60 * 1000);

  const lines = [
    "# OraMedha — dental practice management.",
    "#",
    "# This system holds patient health information. If you have found a way to",
    "# reach data belonging to a clinic or a patient, please tell us before",
    "# telling anyone else, and please do not access, modify or retain any",
    "# record you encounter while demonstrating it.",
    "",
    `Contact: ${contact}`,
    // RFC 9116 requires ISO 8601; seconds precision, UTC.
    `Expires: ${expires.toISOString().replace(/\.\d{3}Z$/, "Z")}`,
    "Preferred-Languages: en",
  ];

  const policy = normalisePolicyUrl(process.env.SECURITY_POLICY_URL);
  if (policy) lines.push(`Policy: ${policy}`);

  return lines.join("\n") + "\n";
}
