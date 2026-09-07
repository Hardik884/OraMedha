import type { NextConfig } from "next";
import { STATIC_SECURITY_HEADERS } from "./lib/security/headers";

/**
 * Server Action origin allow-list.
 *
 * Next.js already rejects a Server Action whose Origin does not match the Host
 * it arrived on, which is what defends against cross-site invocation. This list
 * ADDS origins to that set — it does not narrow it — so shipping
 * "localhost:3000" to production widened the allow-list on the deployed app for
 * a host that only ever matters on a developer machine.
 *
 * It is needed at all because `next dev` can be reached on more than one host
 * (localhost and 127.0.0.1 are different origins to a browser). So the entry
 * exists in development and the list is empty in production, where the
 * same-origin rule is the whole policy.
 */
const serverActionOrigins =
  process.env.NODE_ENV === "production" ? [] : ["localhost:3000", "127.0.0.1:3000"];

const nextConfig: NextConfig = {
  /*
   * `eslint.ignoreDuringBuilds` was true here. It meant a lint error could not
   * fail a deploy, on a project where nothing else ran lint either — there was
   * no CI until .github/workflows/ci.yml. The suppression is removed rather than
   * kept alongside CI: two places that can fail a build should not disagree
   * about whether lint counts.
   */
  /**
   * Security headers that never vary per request. Defined in
   * lib/security/headers.ts and asserted by its spec.
   *
   * Content-Security-Policy is NOT here: it carries a per-request nonce, so it
   * is built and attached by middleware.ts. This block covers every route,
   * including /api and static assets, which the middleware matcher excludes.
   */
  async headers() {
    return [
      {
        source: "/:path*",
        headers: [...STATIC_SECURITY_HEADERS],
      },
    ];
  },
  experimental: {
    serverActions: {
      allowedOrigins: serverActionOrigins,
      /**
       * Server Action request-body cap.
       *
       * Next.js defaults this to 1 MB. Every file upload in DentGrow travels
       * through a Server Action as multipart FormData (consent scans, treatment
       * documents, dentist signatures), so the default silently capped ALL of
       * them at 1 MB — well below the limits those features advertise.
       *
       * Exceeding it is NOT a normal action error: Next rejects the request
       * while parsing the body, before the action function runs, and raises an
       * uncaughtException ("Body exceeded 1 MB limit", statusCode 413). The
       * action's own size check and try/catch never execute, and the client
       * receives an error page instead of an RSC flight response — which
       * surfaced as "Application error: a client-side exception has occurred".
       *
       * Keep this comfortably ABOVE the largest per-file limit the app accepts
       * (see MAX_CONSENT_UPLOAD_SIZE) to leave room for multipart framing and
       * the accompanying metadata fields. Note the hosting platform applies its
       * own request-body cap on top of this (~4.5 MB for Vercel serverless
       * functions), so raising this value alone does not permit larger uploads.
       */
      bodySizeLimit: "6mb",
    },
  },
  images: {
    remotePatterns: [],
  },
};

export default nextConfig;
