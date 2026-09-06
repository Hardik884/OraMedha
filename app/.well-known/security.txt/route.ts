import { NextResponse } from "next/server";
import { securityTxt } from "@/lib/security/security-txt";

/**
 * /.well-known/security.txt — RFC 9116.
 *
 * The location is fixed by the RFC (section 3): a web-based service MUST serve
 * it under /.well-known/. That is the only place a researcher, or the scanners
 * they use, will look, so serving the same content at a prettier path would be
 * the same as not serving it.
 *
 * WHY A ROUTE AND NOT A STATIC FILE IN public/
 *   The file is only valid with a real `Contact:` and a future `Expires:`
 *   (both MUST in RFC 9116). OraMedha has no security contact configured yet,
 *   and the rule this repository already follows for legal links — see
 *   lib/legal/links.ts, which refuses to invent a Terms URL — is that a
 *   document with a fabricated address in it is worse than no document.
 *
 *   So the content is computed: with SECURITY_CONTACT set it is served, and
 *   without it this 404s. `Expires` is likewise derived rather than hardcoded,
 *   because a static file's Expires date silently goes stale and an expired
 *   security.txt is one a researcher is entitled to disregard.
 *
 * Dynamic because `Expires` is relative to now and the contact is read at
 * request time; a build-time value would be wrong the day after a deploy.
 */
export const dynamic = "force-dynamic";

export async function GET(): Promise<NextResponse> {
  const body = securityTxt();

  // No contact configured — say nothing rather than publish an invalid file
  // naming an address that does not exist.
  if (!body) return new NextResponse(null, { status: 404 });

  return new NextResponse(body, {
    status: 200,
    headers: {
      // RFC 9116 section 3: text/plain, charset utf-8.
      "Content-Type": "text/plain; charset=utf-8",
      "Cache-Control": "public, max-age=3600",
    },
  });
}
