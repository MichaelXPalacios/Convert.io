import { z } from "zod";
import {
  CentsSchema,
  DeviceSchema,
  IsoTimestampSchema,
  SessionIdSchema,
  SlugSchema,
  UuidSchema,
  VisitorIdSchema,
} from "./common.js";
import { ConversionProviderSchema } from "./conversion.js";

/**
 * The HTTP boundary.
 *
 * Every route below parses its input with the request schema and returns the
 * response schema. A route that accepts a shape defined anywhere else is
 * outside the contract.
 */

export const ApiErrorSchema = z.object({
  error: z.string().min(1),
  detail: z.string().optional(),
});
export type ApiError = z.infer<typeof ApiErrorSchema>;

// ---------------------------------------------------------------------------
// POST /api/track — record that a visitor was shown an arm
//
// Idempotent on (visitorId, sessionId, armKey). A retry, a refresh inside the
// same session, or a double fire from the edge must return the original
// exposure id rather than creating a second one.
// ---------------------------------------------------------------------------

export const TrackRequestSchema = z.object({
  slug: SlugSchema,
  armKey: SlugSchema,
  visitorId: VisitorIdSchema,
  sessionId: SessionIdSchema,

  utmSource: z.string().max(255).nullish(),
  utmMedium: z.string().max(255).nullish(),
  utmCampaign: z.string().max(255).nullish(),
  utmContent: z.string().max(255).nullish(),
  utmTerm: z.string().max(255).nullish(),

  referrer: z.string().max(2048).nullish(),
  userAgent: z.string().max(1024).nullish(),
  device: DeviceSchema.nullish(),
  country: z.string().max(8).nullish(),
});

export const TrackResponseSchema = z.object({
  exposureId: UuidSchema,
  /**
   * True when the idempotency key matched an existing row. Exposed so tests can
   * assert the admit path and the dedupe path separately rather than only
   * proving that a second write was refused.
   */
  deduplicated: z.boolean(),
});

export type TrackRequest = z.infer<typeof TrackRequestSchema>;
export type TrackResponse = z.infer<typeof TrackResponseSchema>;

// ---------------------------------------------------------------------------
// POST /api/event — engagement
//
// Diagnostic only. Nothing posted here reaches a posterior.
// ---------------------------------------------------------------------------

export const EventRequestSchema = z.object({
  exposureId: UuidSchema,
  type: z.string().min(1).max(64),
  metadata: z.record(z.unknown()).optional(),
  occurredAt: IsoTimestampSchema.optional(),
});

export const EventResponseSchema = z.object({
  eventId: UuidSchema,
});

export type EventRequest = z.infer<typeof EventRequestSchema>;
export type EventResponse = z.infer<typeof EventResponseSchema>;

// ---------------------------------------------------------------------------
// POST /api/webhook/order
//
// Accepts Shopify and Stripe payloads. The signature is verified before the
// body is parsed; an unverifiable signature is a rejection, never a warning.
// ---------------------------------------------------------------------------

/** Shopify `orders/paid`. Lenient: Shopify adds fields freely. */
export const ShopifyOrderSchema = z
  .object({
    id: z.union([z.number(), z.string()]),
    order_number: z.union([z.number(), z.string()]).optional(),
    /** Decimal string, e.g. "129.95". Converted to cents at the boundary. */
    total_price: z.string(),
    currency: z.string().length(3),
    created_at: z.string(),
    email: z.string().nullish(),
    note_attributes: z
      .array(z.object({ name: z.string(), value: z.string() }))
      .optional()
      .default([]),
  })
  .passthrough();

/** Stripe `checkout.session.completed`. */
export const StripeEventSchema = z
  .object({
    id: z.string(),
    type: z.string(),
    data: z.object({
      object: z
        .object({
          id: z.string(),
          /** Already in the currency's minor unit. */
          amount_total: z.number().nullish(),
          currency: z.string().nullish(),
          created: z.number().nullish(),
          client_reference_id: z.string().nullish(),
          customer_email: z.string().nullish(),
          metadata: z.record(z.string()).nullish(),
        })
        .passthrough(),
    }),
  })
  .passthrough();

/**
 * What both provider shapes normalize into before attribution runs. Everything
 * downstream of the webhook sees only this.
 */
export const NormalizedOrderSchema = z.object({
  provider: ConversionProviderSchema,
  externalOrderId: z.string().min(1),
  valueCents: CentsSchema,
  currency: z.string().length(3),
  occurredAt: z.coerce.date(),
  /** Null when the provider sent no visitor id; the order is then unattributable. */
  visitorId: VisitorIdSchema.nullable(),
  email: z.string().nullable(),
});

export const OrderWebhookResponseSchema = z.object({
  conversionId: UuidSchema,
  attributed: z.boolean(),
  /** Present when attributed, so a test can assert it joined the right arm. */
  armId: UuidSchema.nullable(),
  /** Prose when unattributed: outside the window, no exposure, no visitor id. */
  reason: z.string().nullable(),
  deduplicated: z.boolean(),
});

export type ShopifyOrder = z.infer<typeof ShopifyOrderSchema>;
export type StripeEvent = z.infer<typeof StripeEventSchema>;
export type NormalizedOrder = z.infer<typeof NormalizedOrderSchema>;
export type OrderWebhookResponse = z.infer<typeof OrderWebhookResponseSchema>;

/** The note_attributes / metadata key carrying the visitor id through checkout. */
export const ORDER_VISITOR_ATTRIBUTE = "cv_vid";
