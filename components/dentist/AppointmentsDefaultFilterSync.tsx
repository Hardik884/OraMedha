"use client";

/**
 * AppointmentsDefaultFilterSync
 *
 * Reflects the implicit "Upcoming" default into the address bar — WITHOUT a
 * navigation.
 *
 * THE BUG THIS REPLACES
 *   A fresh, unfiltered visit to /dentist/appointments used to be handled by
 *   the Server Component calling `redirect(...?dateFrom=today)`. That produced
 *   a visible skeleton → BLANK SCREEN → content sequence on click: the initial
 *   navigation showed `loading.tsx`, then the mid-render `redirect()` forced
 *   the App Router to tear down that in-flight tree and start an entirely new
 *   navigation to the target URL, and the gap between those two navigations is
 *   where the blank screen came from. This is a known App Router behaviour
 *   (redirect() thrown from a Server Component loses the current loading
 *   boundary while the second navigation spins up) — not a bug specific to
 *   this page, but this page was the one place in the app that hit it.
 *
 * THE FIX
 *   The page no longer redirects. A bare visit renders the Upcoming content
 *   DIRECTLY, on the first and only render — see `effectiveDateFrom` in
 *   page.tsx — so there is nothing left to redirect to and nothing for a
 *   second navigation to interrupt.
 *
 *   That leaves one loose end: the address bar still reads bare
 *   `/dentist/appointments`, so the "Upcoming" quick-filter chip (whose active
 *   state is a literal string match against the URL) won't highlight, and a
 *   bookmark or refresh would not reproduce today's implicit date filter as an
 *   explicit one. This component closes that gap the way the App Router
 *   itself recommends for "the URL should reflect this, but nothing needs to
 *   re-render" cases: it patches `history.replaceState` directly rather than
 *   calling `router.replace()`.
 *
 *   The two are NOT equivalent. `router.replace()` is a real navigation — it
 *   re-runs the Server Component and would reopen the same class of gap this
 *   file exists to close. `history.replaceState()` only changes the address
 *   bar; the App Router patches `pushState`/`replaceState` specifically so
 *   `usePathname()` / `useSearchParams()` (and therefore the quick-filter
 *   chip's active check) pick up the change, with no fetch and no loading
 *   state, because none of the page's data actually changed underneath it.
 *
 * Renders nothing. Mount it once per page; it no-ops whenever `active` is
 * false (i.e. the visit already carried an explicit filter).
 */

import { useEffect } from "react";
import { usePathname } from "next/navigation";

interface AppointmentsDefaultFilterSyncProps {
  /** True only when the page rendered its implicit Upcoming default — i.e. the
   * incoming request carried no filter of its own. */
  active: boolean;
  /** The clinic-local date the implicit filter used, e.g. "2026-09-06". */
  today: string;
}

export function AppointmentsDefaultFilterSync({
  active,
  today,
}: AppointmentsDefaultFilterSyncProps) {
  const pathname = usePathname();

  useEffect(() => {
    if (!active) return;
    window.history.replaceState(null, "", `${pathname}?dateFrom=${today}`);
  }, [active, today, pathname]);

  return null;
}
