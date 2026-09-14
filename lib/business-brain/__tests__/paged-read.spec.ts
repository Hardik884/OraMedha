/**
 * Paged reads: never a silent partial set.
 *
 * The unit cases drive a fake server that caps responses exactly as PostgREST
 * does. The config case pins the assumption the helper rests on.
 */

import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { BoundedReadError, POSTGREST_MAX_ROWS, readAll, readUpTo } from "../paged-read";

/** A table of `n` rows behind a server that returns at most `cap` per response. */
function server(n: number, cap = POSTGREST_MAX_ROWS) {
  const requests: [number, number][] = [];
  const page = (from: number, to: number) => {
    requests.push([from, to]);
    const end = Math.min(to, from + cap - 1, n - 1);
    const data = from > end ? [] : Array.from({ length: end - from + 1 }, (_, i) => ({ id: from + i }));
    return Promise.resolve({ data, error: null });
  };
  return { page, requests };
}

describe("paged reads", () => {
  it("returns every row of a table larger than the server cap, in order", async () => {
    const { page, requests } = server(2345);
    const rows = await readAll<{ id: number }>("t", page, 100_000);
    expect(rows).toHaveLength(2345);
    expect(rows.map((r) => r.id)).toEqual(Array.from({ length: 2345 }, (_, i) => i));
    expect(requests).toEqual([
      [0, 999],
      [1000, 1999],
      [2000, 2999],
    ]);
  });

  it("reports truncation beyond the limit even when the server caps lower than the limit", async () => {
    const { rows, truncated } = await readUpTo<{ id: number }>("t", server(5000).page, 3000);
    expect(rows).toHaveLength(3000);
    expect(truncated).toBe(true);
    const exact = await readUpTo<{ id: number }>("t", server(3000).page, 3000);
    expect(exact.truncated).toBe(false);
    expect(exact.rows).toHaveLength(3000);
  });

  it("refuses to answer whole from a partial read", async () => {
    await expect(readAll("treatments", server(501).page, 500)).rejects.toBeInstanceOf(BoundedReadError);
  });

  it("surfaces a query error instead of an empty result", async () => {
    const failing = () => Promise.resolve({ data: null, error: { message: "boom" } });
    await expect(readUpTo("payments", failing, 10)).rejects.toThrow("payments: boom");
  });

  it("stops after one request for a small result", async () => {
    const { page, requests } = server(12);
    expect(await readAll("t", page, 500)).toHaveLength(12);
    expect(requests).toHaveLength(1);
  });

  it("is the only way Business Brain adapters read many rows: no bare limits, every page callback ranged", () => {
    const dir = join(process.cwd(), "lib/business-brain");
    for (const file of readdirSync(dir).filter((f) => f.endsWith(".ts"))) {
      // Comments may name a limit; only code is checked.
      const source = readFileSync(join(dir, file), "utf8")
        .split(/\r?\n/)
        .filter((line) => !/^\s*(\*|\/\/|\/\*)/.test(line))
        .join("\n");
      // A limit above one row is capped silently by the server; single-row reads are fine.
      for (const m of source.matchAll(/\.limit\(([^)]*)\)/g)) expect(`${file}: .limit(${m[1]})`).toBe(`${file}: .limit(1)`);
      // A paged callback that ignores its range re-reads its first page: every
      // page callback must be matched by a `.range(` call.
      // A callback that only forwards its range to another page callback is not a query.
      const callbacks = [...source.matchAll(/\((?:\w+, )?(?:from|start)_?, (?:to|end)_?\) =>(?!\s*(?:page|query)\()/g)].length;
      const ranges = [...source.matchAll(/\.range\(/g)].length;
      expect(ranges, `${file}: ${callbacks} paged callbacks but ${ranges} .range calls`).toBeGreaterThanOrEqual(callbacks);
    }
  });

  it("rests on a server cap at least as large as the page size", () => {
    const config = readFileSync(join(process.cwd(), "supabase/config.toml"), "utf8");
    const match = /^\s*max_rows\s*=\s*(\d+)/m.exec(config);
    expect(match, "max_rows not found in supabase/config.toml").not.toBeNull();
    expect(Number(match?.[1])).toBeGreaterThanOrEqual(POSTGREST_MAX_ROWS);
  });
});
