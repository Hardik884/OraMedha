/**
 * lib/analytics/fetch-all.ts
 *
 * Reads a whole result set through PostgREST, in pages, instead of hoping it
 * fits under the row cap.
 *
 * THE PROBLEM THIS SOLVES
 *   PostgREST caps a response at `max_rows` — 1000 in supabase/config.toml —
 *   and past that it TRUNCATES SILENTLY. There is no error, no exception, and
 *   the status is still 200. A caller that reduces the rows it got back into a
 *   total has no way to tell a complete answer from a partial one.
 *
 *   lib/analytics/queries.ts is 1,216 lines with 33 selects and, before this,
 *   not a single `.limit()` or `.range()`. Several of them are not even date-
 *   bounded — getAnalyticsSummary reads EVERY treatment and EVERY patient in
 *   the clinic. So every figure on the analytics dashboard was correct only
 *   while the clinic was small, and would have started drifting downward with
 *   no indication that anything had changed. A clinic seeing twenty patients a
 *   day crosses 1,000 treatments in roughly three months.
 *
 * WHY PAGING AND NOT SQL AGGREGATION
 *   Aggregating in the database is the better answer and it is what
 *   clinic_outstanding_balances() (20260907000200) does for the figure that
 *   actually moves money. The analytics module computes dozens of different
 *   shapes — grouped, bucketed, cross-tabulated — from the same handful of row
 *   sets, and rewriting all of it in SQL is a change with a much larger blast
 *   radius than the bug warrants right now.
 *
 *   Paging restores CORRECTNESS without touching any of that arithmetic: the
 *   reducers keep working on exactly the rows they always expected, and now
 *   they get all of them. The payload cost is unchanged and remains a known
 *   performance follow-up.
 *
 * THE HARD STOP
 *   `MAX_PAGES` bounds the work so a runaway query cannot hang a page render
 *   forever. Hitting it THROWS rather than returning what it has: a partial
 *   analytics figure presented as a whole one is the exact failure this module
 *   exists to remove, and swapping a silent truncation at 1,000 rows for a
 *   silent truncation at 100,000 would not be a fix.
 */

/** Rows per request. Kept under the smallest `max_rows` this app runs against. */
const PAGE_SIZE = 1000;

/**
 * Pages before giving up. 100 × 1000 = 100,000 rows, which is far beyond any
 * single clinic's treatment or payment history and still bounded.
 */
const MAX_PAGES = 100;

/**
 * A PostgREST query builder that has not yet been awaited.
 *
 * Typed loosely on purpose: the Supabase client's builder types do not survive
 * being passed around generically, and every call site here already casts its
 * data layer (see the DbClient alias the Server Actions use).
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type PagedQuery = { range: (from: number, to: number) => Promise<{ data: any[] | null; error: any }> };

/**
 * Reads every row a query matches.
 *
 * Pass a builder WITHOUT `.range()` or `.limit()` already applied — this adds
 * them. The builder is re-ranged per page, so it must be a fresh one per call.
 *
 * @param build  Returns the query. Called once per page so each request gets an
 *               unconsumed builder.
 * @param label  Used in the error message when the page bound is hit.
 */
export async function fetchAllRows<T>(
  build: () => PagedQuery,
  label: string
): Promise<T[]> {
  const rows: T[] = [];

  for (let page = 0; page < MAX_PAGES; page++) {
    const from = page * PAGE_SIZE;
    const { data, error } = await build().range(from, from + PAGE_SIZE - 1);

    if (error) throw new Error(`${label}: ${error.message ?? "query failed"}`);

    const batch = (data ?? []) as T[];
    rows.push(...batch);

    // A short page is the last page. This is the only reliable end condition:
    // PostgREST does not tell us whether more rows exist unless we ask for an
    // exact count, which costs a second scan on every page.
    if (batch.length < PAGE_SIZE) return rows;
  }

  throw new Error(
    `${label}: exceeded ${MAX_PAGES * PAGE_SIZE} rows. Refusing to return a ` +
      `partial result — the figure computed from it would be wrong with no ` +
      `indication that it was. This query needs a date bound or a SQL aggregate.`
  );
}
