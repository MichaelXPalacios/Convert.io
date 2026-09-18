import { z } from "zod";
import { CentsSchema, SlugSchema, TimestampSchema, UuidSchema } from "./common.js";

export const ExperimentStatusSchema = z.enum(["draft", "running", "paused", "archived"]);

/** A row of `experiments`. Mirrors db/001_init.sql exactly. */
export const ExperimentSchema = z.object({
  id: UuidSchema,
  slug: SlugSchema,
  name: z.string().min(1),
  status: ExperimentStatusSchema,

  /**
   * Per-experiment guardrail values. The allocation function treats these as
   * the configured minimum and applies the hard floor on top, so a bad row
   * cannot widen the guardrail.
   */
  explorationFloor: z.number().gt(0).lt(1),
  minExposures: z.number().int().nonnegative(),
  attributionWindowHours: z.number().int().positive(),
  rewardCapCents: CentsSchema.pipe(z.number().positive()),

  createdAt: TimestampSchema,
  updatedAt: TimestampSchema,
});

export type Experiment = z.infer<typeof ExperimentSchema>;
export type ExperimentStatus = z.infer<typeof ExperimentStatusSchema>;
