import { z } from "zod";

/**
 * Primitives shared by every boundary. Defined once so that "an id" and "money"
 * mean the same thing in the collector, the worker, the edge and the admin.
 */

export const UuidSchema = z.string().uuid();

/**
 * Money is always integer cents. Never a float, never a formatted string.
 * Posteriors are computed from sums of this, and floating point loses cents.
 */
export const CentsSchema = z.number().int().nonnegative();

/** ISO 8601 with offset. The shape money and time take when crossing HTTP. */
export const IsoTimestampSchema = z.string().datetime({ offset: true });

/** Timestamps read back out of Postgres. */
export const TimestampSchema = z.coerce.date();

/** First party identifiers. Opaque to everything except the collector. */
export const VisitorIdSchema = z.string().min(1).max(128);
export const SessionIdSchema = z.string().min(1).max(128);

/** URL-safe identifier used in paths, filenames and Redis fields. */
export const SlugSchema = z
  .string()
  .min(1)
  .max(64)
  .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/, "must be lowercase kebab-case");

export const DeviceSchema = z.enum(["mobile", "tablet", "desktop", "bot"]);

export const UtmSchema = z.object({
  utmSource: z.string().max(255).nullable().default(null),
  utmMedium: z.string().max(255).nullable().default(null),
  utmCampaign: z.string().max(255).nullable().default(null),
  utmContent: z.string().max(255).nullable().default(null),
  utmTerm: z.string().max(255).nullable().default(null),
});

export type Uuid = z.infer<typeof UuidSchema>;
export type Cents = z.infer<typeof CentsSchema>;
export type Device = z.infer<typeof DeviceSchema>;
export type Utm = z.infer<typeof UtmSchema>;

/**
 * Cookie names and lifetimes. The collector sets these server side; nothing
 * else is allowed to invent a name for them.
 */
export const COOKIE_VISITOR = "cv_vid";
export const COOKIE_SESSION = "cv_sid";
export const COOKIE_ASSIGNMENT = "cv_arm";

export const VISITOR_COOKIE_MAX_AGE_SECONDS = 180 * 24 * 60 * 60;
export const SESSION_COOKIE_MAX_AGE_SECONDS = 30 * 60;

/**
 * Guardrails. These are the floor values the system enforces regardless of what
 * any configuration says. `lib/assign.ts` applies EXPLORATION_FLOOR whether or
 * not a caller passes one, because a guardrail a caller can omit is not a
 * guardrail.
 */
export const EXPLORATION_FLOOR = 0.1;
export const MIN_EXPOSURES_BEFORE_PROMOTION = 1000;
export const DEFAULT_ATTRIBUTION_WINDOW_HOURS = 168;

/**
 * Reward normalization cap in cents.
 *
 * Revenue per visitor is mapped into [0,1] by min(revenue, cap) / cap before it
 * updates a Beta posterior. Without a cap, one unusually large order moves an
 * arm's posterior further than a hundred ordinary ones, and the bandit chases
 * the outlier instead of the trend.
 */
export const DEFAULT_REWARD_CAP_CENTS = 20_000;
