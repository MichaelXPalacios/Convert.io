/**
 * The posterior recompute, on a schedule.
 *
 * Vercel Cron invokes this every 15 minutes (see vercel.json, which is where
 * the schedule lives so it sits next to the code it runs). The route is thin
 * on purpose: every decision it makes is somebody else's, and all it owns is
 * the order those decisions happen in.
 *
 * GET, not POST. Vercel Cron issues GET and there is no way to ask it for
 * anything else. The method grants nothing -- the CRON_SECRET bearer token is
 * the whole of the authentication, and a GET that recomputes is fine so long
 * as nothing caches it, which `force-dynamic` and the Authorization header
 * between them ensure.
 *
 * The ordering that matters:
 *
 *   1. recompute and COMMIT the posteriors rows
 *   2. only then publish the mirror
 *
 * Backwards, the edge would allocate against numbers that do not exist yet,
 * and a crash between the two would leave the mirror describing rows that were
 * rolled back. Postgres is the source of truth; the mirror is a copy, and a
 * copy is allowed to lag but never to lead.
 */

import { NextResponse } from "next/server";
import pg from "pg";
import { authorizeCron, mulberry32, sampleBeta } from "@convertio/core";
import { mirrorPublisherFromEnv, recomputeAll } from "@convertio/worker";
import type { QueryFn, QueryResultLike } from "@convertio/worker";

export const dynamic = "force-dynamic";

/**
 * Well under Vercel's ceiling, and well over what a recompute of this size
 * takes. A run that needs longer is a run that has found a problem worth
 * failing on rather than a run that needs more time.
 */
export const maxDuration = 60;

/**
 * Who may run this is decided in @convertio/core, not here.
 *
 * A Next route cannot be imported outside Next's bundler, so a check written
 * inline in this file cannot be unit tested -- and this is the check standing
 * in front of a route that rewrites every posterior in the system.
 */

export async function GET(request: Request): Promise<NextResponse> {
  const allowed = authorizeCron(request.headers.get("authorization"), process.env.CRON_SECRET);
  if (!allowed.ok) {
    if (allowed.status === 503) {
      console.error("[cv] CRON_SECRET is unset; refusing to run the recompute");
    }
    return NextResponse.json({ error: allowed.error }, { status: allowed.status });
  }

  const connectionString = process.env.DATABASE_URL;
  if (connectionString === undefined || connectionString === "") {
    console.error("[cv] DATABASE_URL is unset");
    return NextResponse.json({ error: "database is not configured" }, { status: 503 });
  }

  // Built before the database work starts. A missing Upstash variable should
  // fail the run before it writes posteriors it cannot publish, not after.
  let publisher;
  try {
    publisher = mirrorPublisherFromEnv(process.env);
  } catch (error) {
    console.error("[cv] mirror publisher unavailable:", error);
    return NextResponse.json({ error: "mirror is not configured" }, { status: 503 });
  }

  const started = Date.now();
  const client = new pg.Client({ connectionString });
  await client.connect();

  // Where two type systems meet. `pg` constrains its rows to QueryResultRow --
  // anything with a string index signature -- while the worker's QueryFn is
  // generic over an arbitrary row shape it declares at each call site. Neither
  // constraint implies the other, so the bridge is a cast. It is sound because
  // the SQL and the row types on the other side are the worker's own: this
  // route never names a column.
  const query: QueryFn = <R>(sql: string, params?: unknown[]) =>
    client.query(sql, params) as unknown as Promise<QueryResultLike<R>>;

  let recomputed;
  try {
    // One transaction around the whole recompute: a half-updated set of
    // posteriors is a set of allocations that do not sum to one.
    await client.query("BEGIN");
    recomputed = await recomputeAll({
      query,
      // Seeded from the clock rather than fixed: two runs should not draw the
      // same samples, and nothing here needs reproducibility. Math.random
      // would do; this keeps the sampler's source explicit and swappable.
      sampleBeta: (alpha, beta) =>
        sampleBeta(alpha, beta, mulberry32(Date.now() ^ (Math.random() * 2 ** 32))),
    });
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    console.error("[cv] recompute failed and was rolled back:", error);
    return NextResponse.json({ error: "recompute failed" }, { status: 500 });
  } finally {
    await client.end().catch(() => undefined);
  }

  // Published one experiment at a time, after the commit. A publish failure
  // does not undo the recompute: the rows are correct and durable, and the
  // next run will publish them. It is reported so that a mirror stuck behind
  // Postgres is visible rather than silent.
  const published: string[] = [];
  const failed: string[] = [];

  for (const experiment of recomputed) {
    try {
      await publisher.publish({ key: experiment.mirrorKey, fields: experiment.mirrorFields });
      published.push(experiment.slug);
    } catch (error) {
      failed.push(experiment.slug);
      console.error(`[cv] mirror publish failed for "${experiment.slug}":`, error);
    }
  }

  return NextResponse.json(
    {
      experiments: recomputed.length,
      published,
      failed,
      cold: recomputed.filter((e) => e.isCold).map((e) => e.slug),
      durationMs: Date.now() - started,
    },
    { status: failed.length === 0 ? 200 : 207 },
  );
}
