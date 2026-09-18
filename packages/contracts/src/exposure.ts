import { z } from "zod";
import {
  DeviceSchema,
  SessionIdSchema,
  TimestampSchema,
  UuidSchema,
  VisitorIdSchema,
} from "./common.js";

/**
 * A row of `exposures`: a visitor was shown an arm.
 *
 * This is the root of every reward signal in the system. A conversion that
 * cannot find one of these is unattributed, and an unattributed order teaches
 * the bandit nothing.
 */
export const ExposureSchema = z.object({
  id: UuidSchema,
  experimentId: UuidSchema,
  armId: UuidSchema,

  visitorId: VisitorIdSchema,
  sessionId: SessionIdSchema,

  assignedAt: TimestampSchema,

  utmSource: z.string().nullable(),
  utmMedium: z.string().nullable(),
  utmCampaign: z.string().nullable(),
  utmContent: z.string().nullable(),
  utmTerm: z.string().nullable(),

  referrer: z.string().nullable(),
  userAgent: z.string().nullable(),
  device: DeviceSchema.nullable(),
  country: z.string().nullable(),

  createdAt: TimestampSchema,
});

export type Exposure = z.infer<typeof ExposureSchema>;

/**
 * A row of `events`: engagement.
 *
 * Diagnostic only, and deliberately not part of the reward. A click tells you
 * something about an ad; it tells you nothing reliable about whether a page
 * makes money, and optimizing it is the failure mode this product exists to
 * avoid.
 */
export const EventSchema = z.object({
  id: UuidSchema,
  exposureId: UuidSchema,
  type: z.string().min(1).max(64),
  metadata: z.record(z.unknown()).default({}),
  occurredAt: TimestampSchema,
  createdAt: TimestampSchema,
});

export type ExposureEvent = z.infer<typeof EventSchema>;
