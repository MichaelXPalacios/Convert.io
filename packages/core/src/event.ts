/**
 * Engagement events.
 *
 * Diagnostic only, and the schema says so in a comment that is worth repeating
 * here: nothing written through this function ever reaches a posterior. The
 * reward is revenue. A click is evidence about an ad, not about a page, and an
 * arm that collects clicks while selling nothing is a losing arm that looks
 * busy.
 *
 * They are recorded anyway because "the variant with more engagement converts
 * worse" is a thing an operator needs to be able to see.
 */

import { EventRequestSchema } from "@convertio/contracts";
import type { EventRequest, EventResponse } from "@convertio/contracts";
import type { Queryable } from "./exposure.js";

interface EventRow {
  id: string;
}

/**
 * Not idempotent, unlike an exposure.
 *
 * Two identical clicks a second apart are two clicks, and there is no key that
 * could tell a repeat from a retry without inventing one the client would have
 * to send honestly. The cost of a duplicate is a slightly high count on a
 * diagnostic dimension; the cost of collapsing real repeats would be a metric
 * that silently under-reports.
 */
const RECORD_EVENT_SQL = `
INSERT INTO events (exposure_id, type, metadata, occurred_at)
VALUES ($1, $2, $3::jsonb, COALESCE($4::timestamptz, now()))
RETURNING id
`;

/**
 * Record an engagement event against an exposure.
 *
 * Returns undefined when the exposure does not exist, which a foreign key
 * violation would otherwise surface as a 500. A stale page posting against an
 * exposure that has since been deleted is a normal thing to receive.
 */
export async function recordEvent(
  db: Queryable,
  request: EventRequest,
): Promise<EventResponse | undefined> {
  const input = EventRequestSchema.parse(request);

  try {
    const { rows } = await db.query<EventRow>(RECORD_EVENT_SQL, [
      input.exposureId,
      input.type,
      JSON.stringify(input.metadata ?? {}),
      input.occurredAt ?? null,
    ]);

    const row = rows[0];
    return row === undefined ? undefined : { eventId: row.id };
  } catch (error) {
    // 23503 is foreign_key_violation: the exposure is gone.
    if (typeof error === "object" && error !== null && "code" in error) {
      if ((error as { code?: unknown }).code === "23503") return undefined;
    }
    throw error;
  }
}
