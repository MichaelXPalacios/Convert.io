import { z } from "zod";
import { CentsSchema, TimestampSchema, UuidSchema, VisitorIdSchema } from "./common.js";

export const ConversionProviderSchema = z.enum(["shopify", "stripe", "manual"]);

/**
 * A row of `conversions`: an order, joined back to the exposure that earned it.
 *
 * `exposureId` is nullable on purpose. An order arriving with no exposure inside
 * the attribution window is still a real fact worth storing, and storing it is
 * how the unattributed rate becomes visible instead of silently disappearing.
 * It simply never reaches a posterior.
 */
export const ConversionSchema = z.object({
  id: UuidSchema,
  exposureId: UuidSchema.nullable(),
  experimentId: UuidSchema.nullable(),
  armId: UuidSchema.nullable(),

  visitorId: VisitorIdSchema,

  provider: ConversionProviderSchema,
  externalOrderId: z.string().min(1),

  /** The real order total. Integer cents. This is the reward. */
  valueCents: CentsSchema,
  currency: z.string().length(3),

  occurredAt: TimestampSchema,
  createdAt: TimestampSchema,
});

export type Conversion = z.infer<typeof ConversionSchema>;
export type ConversionProvider = z.infer<typeof ConversionProviderSchema>;

/**
 * The result of running the attribution rule.
 *
 * The rule is: the last exposure for this visitor within the window wins, ties
 * broken by the most recent. It lives in exactly one function so that changing
 * it later is a one-line change rather than an archaeology exercise.
 */
export const AttributionResultSchema = z.discriminatedUnion("attributed", [
  z.object({
    attributed: z.literal(true),
    exposureId: UuidSchema,
    experimentId: UuidSchema,
    armId: UuidSchema,
    /** How long after the exposure the order arrived. */
    latencyHours: z.number().nonnegative(),
  }),
  z.object({
    attributed: z.literal(false),
    /** Prose, so the admin log can say why an order went unattributed. */
    reason: z.string().min(1),
  }),
]);

export type AttributionResult = z.infer<typeof AttributionResultSchema>;
