import { z } from "zod";
import { TimestampSchema, UuidSchema } from "./common.js";

export const DecisionActionSchema = z.enum([
  "create_experiment",
  "create_arm",
  "promote",
  "pause",
  "resume",
  "retire",
  "rollback",
  "allocation_change",
  "approve_proposal",
  "reject_proposal",
]);

/**
 * A row of `decisions`: the append-only audit log.
 *
 * Every state change to an arm writes one of these. Nothing updates or deletes
 * them. If a change to an arm happened and there is no row here explaining it,
 * that is a bug, not a gap in the log.
 */
export const DecisionSchema = z.object({
  id: UuidSchema,
  experimentId: UuidSchema.nullable(),
  armId: UuidSchema.nullable(),

  action: DecisionActionSchema,

  /**
   * Prose a person can read six months later. Not an enum, not a code: the
   * point of the log is to carry why, and an enum cannot carry why.
   */
  reason: z.string().min(1),

  /** 'system:cron' for the worker, an operator email for the admin surface. */
  actor: z.string().min(1),

  metadata: z.record(z.unknown()).default({}),

  createdAt: TimestampSchema,
});

export type Decision = z.infer<typeof DecisionSchema>;
export type DecisionAction = z.infer<typeof DecisionActionSchema>;

/** The actor string the cron worker writes. */
export const ACTOR_SYSTEM_CRON = "system:cron";

/** What a caller must supply to record a decision. */
export const NewDecisionSchema = DecisionSchema.omit({ id: true, createdAt: true }).extend({
  metadata: z.record(z.unknown()).optional(),
});

export type NewDecision = z.infer<typeof NewDecisionSchema>;
