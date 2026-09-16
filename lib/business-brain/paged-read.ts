/**
 * lib/business-brain/paged-read.ts
 *
 * The only way a Business Brain adapter reads more than a handful of rows.
 *
 * ## Why this exists
 *
 * PostgREST caps every response at `max_rows` (1000 locally and on Supabase by
 * default) and does so SILENTLY: `.limit(5000)` returns 1000 rows, and a query
 * with no limit returns 1000 rows, with no error and no marker. Every read that
 * could exceed the cap therefore returned a partial set that looked complete —
 * the latest history days, a clinic's older treatments and payments, the tail of
 * a ledger window — and every truncation check of the form `rows.length > limit`
 * could never fire, because the server stopped at 1000 first.
 *
 * ## The two reads
 *
 *   readUpTo   up to `limit` rows across pages, and whether more existed. For
 *              bounded reads whose consumers report truncation honestly.
 *   readAll    every row, or a BoundedReadError when more than `max` exist. For
 *              reads that are only meaningful whole — a cumulative balance, a
 *              roster — where a partial answer would be a wrong answer.
 *
 * Every query passed here MUST carry a total order (end with a unique column),
 * or rows can repeat or vanish between pages.
 */

/**
 * The server's per-response row cap. `supabase/config.toml` must keep `max_rows`
 * at least this large — `paged-read.spec.ts` reads the file and fails otherwise —
 * and so must the hosted project, whose default is also 1000. A lower server cap
 * would make a short page look like the last one.
 */
export const POSTGREST_MAX_ROWS = 1000;

type PageResult = PromiseLike<{ data: unknown; error: { message: string } | null }>;

/** One page of an ordered query: rows `from`…`to`, inclusive. */
export type PageQuery = (from: number, to: number) => PageResult;

export class BoundedReadError extends Error {
  constructor(
    readonly label: string,
    readonly max: number,
  ) {
    super(`${label}: more than ${max} rows; refusing to answer from a partial read.`);
    this.name = "BoundedReadError";
  }
}

export async function readUpTo<T>(label: string, page: PageQuery, limit: number): Promise<{ rows: T[]; truncated: boolean }> {
  if (!Number.isInteger(limit) || limit < 0) throw new RangeError(`${label}: limit must be a non-negative integer.`);
  const rows: T[] = [];
  const wanted = limit + 1;
  let offset = 0;
  while (offset < wanted) {
    const size = Math.min(POSTGREST_MAX_ROWS, wanted - offset);
    const { data, error } = await page(offset, offset + size - 1);
    if (error) throw new Error(`${label}: ${error.message}`);
    const batch = (data ?? []) as T[];
    rows.push(...batch);
    if (batch.length < size) break;
    offset += batch.length;
  }
  return rows.length > limit ? { rows: rows.slice(0, limit), truncated: true } : { rows, truncated: false };
}

export async function readAll<T>(label: string, page: PageQuery, max: number): Promise<T[]> {
  const { rows, truncated } = await readUpTo<T>(label, page, max);
  if (truncated) throw new BoundedReadError(label, max);
  return rows;
}
