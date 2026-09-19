/**
 * Recording an exposure.
 *
 * An exposure is the root of every reward signal in the system: a conversion
 * that cannot find one is unattributable, and an unattributable order teaches
 * the bandit nothing. So this path has exactly two jobs, and both are about
 * counting correctly rather than counting much.
 *
 * Idempotency is the first. The schema enforces UNIQUE (visitor_id, session_id,
 * arm_id) because a retried write, a double fire, or a refresh inside the same
 * session must not inflate the denominator of a posterior. An arm whose
 * exposures are double counted looks worse than it is, and the bandit will
 * correctly act on an incorrect number.
 *
 * Atomicity is the second. Resolving (slug, armKey) to an arm id and then
 * inserting would be two round trips with a race between them, so it is one
 * statement: the CTE resolves, inserts on conflict do nothing, and then reports
 * either the row it created or the row that was already there.
 *
 * The driver is injected. Nothing here imports a Postgres client, which is what
 * keeps @convertio/core free of a dependency the browser bundle would have to
 * carry.
 */

import { TrackRequestSchema } from "@convertio/contracts";
import type { TrackRequest, TrackResponse } from "@convertio/contracts";

/** The slice of a Postgres client this module needs. `pg.Pool` satisfies it. */
export interface Queryable {
  query<R>(sql: string, params: readonly unknown[]): Promise<{ rows: R[] }>;
}

/**
 * Resolve, insert-if-absent, and report which happened — in one statement.
 *
 * `ins` is the insert. The second branch of the UNION only runs when `ins`
 * produced nothing, which is precisely the case where the unique constraint
 * already held a row for this (visitor, session, arm).
 */
const RECORD_EXPOSURE_SQL = `
WITH target AS (
  SELECT a.id AS arm_id, a.experiment_id AS experiment_id
  FROM arms a
  JOIN experiments e ON e.id = a.experiment_id
  WHERE e.slug = $1 AND a.key = $2
),
ins AS (
  INSERT INTO exposures (
    experiment_id, arm_id, visitor_id, session_id,
    utm_source, utm_medium, utm_campaign, utm_content, utm_term,
    referrer, user_agent, device, country
  )
  SELECT
    t.experiment_id, t.arm_id, $3, $4,
    $5, $6, $7, $8, $9,
    $10, $11, $12, $13
  FROM target t
  ON CONFLICT (visitor_id, session_id, arm_id) DO NOTHING
  RETURNING id
)
SELECT id, true AS inserted FROM ins
UNION ALL
SELECT e.id, false AS inserted
FROM exposures e
JOIN target t ON t.arm_id = e.arm_id
WHERE e.visitor_id = $3
  AND e.session_id = $4
  AND NOT EXISTS (SELECT 1 FROM ins)
LIMIT 1
`;

interface ExposureRow {
  id: string;
  inserted: boolean;
}

/**
 * Record that a visitor was shown an arm.
 *
 * Returns undefined when no arm matches (slug, armKey). That is a 404 rather
 * than an error: a stale page posting an arm key that has since been removed is
 * a normal thing to receive, not a fault to alert on.
 *
 * Throws only on a genuinely malformed request or a database failure. The
 * caller decides whether a failure here is worth failing the response over —
 * for a pageview it is not, because a lost exposure costs one data point and a
 * failed render costs the visitor.
 */
export async function recordExposure(
  db: Queryable,
  request: TrackRequest,
): Promise<TrackResponse | undefined> {
  const input = TrackRequestSchema.parse(request);

  const { rows } = await db.query<ExposureRow>(RECORD_EXPOSURE_SQL, [
    input.slug,
    input.armKey,
    input.visitorId,
    input.sessionId,
    input.utmSource ?? null,
    input.utmMedium ?? null,
    input.utmCampaign ?? null,
    input.utmContent ?? null,
    input.utmTerm ?? null,
    input.referrer ?? null,
    input.userAgent ?? null,
    input.device ?? null,
    input.country ?? null,
  ]);

  const row = rows[0];
  if (row === undefined) return undefined;

  return { exposureId: row.id, deduplicated: !row.inserted };
}
