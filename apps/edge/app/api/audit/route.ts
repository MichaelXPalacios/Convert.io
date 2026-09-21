/**
 * Read a landing page and propose variants worth testing.
 *
 * Thin on purpose, like the other routes: every decision here belongs to
 * somebody else. A Next route module cannot be imported outside Next's
 * bundler, so anything written inline in this file cannot be unit tested —
 * and the rule most needing a test is which URLs the server will fetch.
 * That rule lives in @convertio/audit, with eighteen tests behind it.
 *
 * WHY THIS ROUTE IS AUTHENTICATED, and why that is not the whole answer.
 *
 * It takes a URL from the caller and makes the server fetch it, then spends
 * money turning the result into tokens. Authentication decides *who* may aim
 * the server; it does nothing about *where* it can be aimed. An authenticated
 * caller could still ask for cloud metadata or sweep localhost. So the URL
 * policy in @convertio/audit is a separate defence, enforced whether or not
 * the caller is trusted, and re-applied at every redirect.
 *
 * Nothing is persisted. A finding becomes a `proposals` row only once it is
 * attached to an experiment, and `proposals.experiment_id` is NOT NULL while
 * an audit takes a URL rather than a slug. Persisting would mean inventing an
 * experiment to satisfy a foreign key, which would put rows in the table the
 * recompute scans. Slug-scoped persistence is a deliberate second step.
 */

import { NextResponse } from "next/server";
import { authorizeCron } from "@convertio/core";
import { analyze, extractFacts, fetchPage, UrlPolicyError } from "@convertio/audit";
import { AuditRequestSchema } from "@convertio/contracts";

export const dynamic = "force-dynamic";

/**
 * Longer than the worker's, because most of it is spent waiting on a model
 * rather than on our own work. The page fetch is capped separately at ten
 * seconds inside the policy, so a slow *site* cannot consume this budget.
 */
export const maxDuration = 120;

export async function POST(request: Request): Promise<NextResponse> {
  /**
   * Reusing the cron secret rather than minting a second one.
   *
   * `authorizeCron` takes the expected value as an argument, so it is a
   * generic bearer check that happens to be named for its first caller. The
   * comparison inside it is constant-time and handles unequal lengths, which
   * is why this does not write its own.
   *
   * The conflation is a known compromise: rotating one token rotates access
   * to both routes. When this becomes operator-facing it should get its own
   * secret, or sit behind the admin identity that ADMIN_ALLOWED_EMAILS
   * anticipates and nothing yet implements.
   */
  const allowed = authorizeCron(request.headers.get("authorization"), process.env.CRON_SECRET);
  if (!allowed.ok) {
    if (allowed.status === 503) {
      console.error("[cv] CRON_SECRET is unset; refusing to run an audit");
    }
    return NextResponse.json({ error: allowed.error }, { status: allowed.status });
  }

  if (!process.env.ANTHROPIC_API_KEY) {
    // Checked before the page is fetched. Failing after we have already made
    // someone's server serve us a page is rude and pointless.
    console.error("[cv] ANTHROPIC_API_KEY is unset; refusing to run an audit");
    return NextResponse.json({ error: "the audit engine is not configured" }, { status: 503 });
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "expected a JSON body" }, { status: 400 });
  }

  const parsed = AuditRequestSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: "invalid request", detail: parsed.error.issues.map((i) => i.message) },
      { status: 400 },
    );
  }

  const started = Date.now();

  let page;
  try {
    page = await fetchPage(parsed.data.url);
  } catch (error) {
    if (error instanceof UrlPolicyError) {
      // The policy's own status: 400 for a URL we will not touch, 502 for a
      // site that failed us, 413 for one too large, 415 for a non-page.
      return NextResponse.json({ error: error.message }, { status: error.status });
    }
    console.error("[cv] audit fetch failed:", error);
    return NextResponse.json({ error: "could not fetch that page" }, { status: 502 });
  }

  const facts = extractFacts(page.url, page.html);

  let analysis;
  try {
    analysis = await analyze(facts, parsed.data.context ?? "");
  } catch (error) {
    console.error("[cv] audit analysis failed:", error);
    return NextResponse.json({ error: "the audit engine failed" }, { status: 502 });
  }

  return NextResponse.json(
    {
      url: page.url,
      truncated: page.truncated,
      summary: analysis.summary,
      audienceRead: analysis.audienceRead,
      biggestLeak: analysis.biggestLeak,
      findings: analysis.findings,
      signals: facts.signals,
      durationMs: Date.now() - started,
    },
    { status: 200 },
  );
}
