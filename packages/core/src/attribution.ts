/**
 * Order attribution.
 *
 * The rule, stated once and implemented once, as the contract asks: the last
 * exposure for this visitor within the experiment attribution window wins,
 * ties broken by the most recent.
 *
 * Last-touch is a choice, not a fact. A visitor who saw the control on Monday
 * and a variant on Friday before buying credits the variant entirely, and a
 * different business could defensibly split it. It is written here in one
 * statement so that changing it later is a one-line change rather than an
 * archaeology exercise across three call sites.
 *
 * An order that finds no exposure is still recorded. An unattributed order is
 * a real fact -- it is revenue the experiment did not explain -- and storing it
 * is how the unattributed rate stays visible instead of silently disappearing.
 * It simply never reaches a posterior, because conversions with a null arm_id
 * are invisible to the recompute.
 */

import { DEFAULT_ATTRIBUTION_WINDOW_HOURS } from "@convertio/contracts";
import type {
  AttributionResult,
  NormalizedOrder,
  OrderWebhookResponse,
} from "@convertio/contracts";
import type { Queryable } from "./exposure.js";

/**
 * The winning exposure, if there is one.
 *
 * The window comes from the exposure's own experiment rather than a constant,
 * because a slow-considered-purchase store and an impulse store need different
 * ones and the column already exists to say so. COALESCE covers the case where
 * an experiment predates the column having a value.
 */
const ATTRIBUTE_SQL = `
SELECT e.id            AS exposure_id,
       e.experiment_id AS experiment_id,
       e.arm_id        AS arm_id,
       EXTRACT(EPOCH FROM ($2::timestamptz - e.assigned_at)) / 3600 AS latency_hours
  FROM exposures e
  JOIN experiments x ON x.id = e.experiment_id
 WHERE e.visitor_id = $1
   AND e.assigned_at <= $2::timestamptz
   AND e.assigned_at >= $2::timestamptz
       - (COALESCE(x.attribution_window_hours, $3::int) * INTERVAL '1 hour')
 ORDER BY e.assigned_at DESC, e.id DESC
 LIMIT 1
`;

interface AttributionRow {
  exposure_id: string;
  experiment_id: string;
  arm_id: string;
  latency_hours: string | number;
}

/**
 * Apply the attribution rule to a normalized order.
 *
 * Pure with respect to everything but the query: it decides, and writes
 * nothing. The caller records the conversion, so that the decision can be
 * tested against a fake database and inspected without committing to it.
 */
export async function attributeOrder(
  db: Queryable,
  order: NormalizedOrder,
): Promise<AttributionResult> {
  if (order.visitorId === null) {
    return {
      attributed: false,
      reason: "the provider sent no visitor id, so the order cannot be matched to an exposure",
    };
  }

  const { rows } = await db.query<AttributionRow>(ATTRIBUTE_SQL, [
    order.visitorId,
    order.occurredAt.toISOString(),
    DEFAULT_ATTRIBUTION_WINDOW_HOURS,
  ]);

  const row = rows[0];
  if (row === undefined) {
    return {
      attributed: false,
      reason: "no exposure for this visitor inside the attribution window",
    };
  }

  return {
    attributed: true,
    exposureId: row.exposure_id,
    experimentId: row.experiment_id,
    armId: row.arm_id,
    // node-postgres returns numeric as a string to avoid precision loss, so
    // this arrives as "3.5" rather than 3.5 and must be coerced explicitly.
    latencyHours: Math.max(0, Number(row.latency_hours)),
  };
}

/**
 * Insert-if-absent, and report which happened.
 *
 * Payment providers retry webhooks, so the same order must never count twice:
 * the unique index on (provider, external_order_id) is the guard, and the
 * UNION's second branch reads back the row that already held the key. The
 * shape mirrors recordExposure deliberately -- both are idempotent writes whose
 * caller needs to know which path it took.
 */
const RECORD_CONVERSION_SQL = `
WITH ins AS (
  INSERT INTO conversions
    (exposure_id, experiment_id, arm_id, visitor_id, provider,
     external_order_id, value_cents, currency, occurred_at)
  VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9::timestamptz)
  ON CONFLICT (provider, external_order_id) DO NOTHING
  RETURNING id, arm_id
)
SELECT id, arm_id, true AS inserted FROM ins
UNION ALL
SELECT c.id, c.arm_id, false AS inserted
  FROM conversions c
 WHERE c.provider = $5
   AND c.external_order_id = $6
   AND NOT EXISTS (SELECT 1 FROM ins)
LIMIT 1
`;

interface ConversionRow {
  id: string;
  arm_id: string | null;
  inserted: boolean;
}

/**
 * Record an order, attributed or not.
 *
 * `visitor_id` is NOT NULL in the schema, so an order with no visitor id is
 * stored under a sentinel rather than rejected. Losing the row entirely would
 * lose the revenue from the unattributed rate, which is the number that tells
 * an operator their checkout is dropping the visitor id.
 */
export const UNKNOWN_VISITOR = "unknown";

export async function recordConversion(
  db: Queryable,
  order: NormalizedOrder,
  attribution: AttributionResult,
): Promise<OrderWebhookResponse> {
  const { rows } = await db.query<ConversionRow>(RECORD_CONVERSION_SQL, [
    attribution.attributed ? attribution.exposureId : null,
    attribution.attributed ? attribution.experimentId : null,
    attribution.attributed ? attribution.armId : null,
    order.visitorId ?? UNKNOWN_VISITOR,
    order.provider,
    order.externalOrderId,
    order.valueCents,
    order.currency,
    order.occurredAt.toISOString(),
  ]);

  const row = rows[0];
  if (row === undefined) {
    throw new Error(
      `conversion for ${order.provider}:${order.externalOrderId} neither inserted nor found`,
    );
  }

  return {
    conversionId: row.id,
    attributed: attribution.attributed,
    armId: row.arm_id,
    reason: attribution.attributed ? null : attribution.reason,
    deduplicated: !row.inserted,
  };
}
