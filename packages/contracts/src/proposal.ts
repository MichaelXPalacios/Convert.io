import { z } from "zod";
import { TimestampSchema, UuidSchema } from "./common.js";
import { ArmContentSchema } from "./arm.js";

export const ProposalStatusSchema = z.enum(["pending", "approved", "rejected"]);
export const ProposalSourceSchema = z.enum(["audit", "manual"]);

/**
 * A row of `proposals`: a suggested variant awaiting a human.
 *
 * Stage 1 has no autonomous writes. A proposal becomes an arm only when a
 * person approves it in the admin queue, and that approval writes a decisions
 * row naming them.
 */
export const ProposalSchema = z
  .object({
    id: UuidSchema,
    experimentId: UuidSchema,

    source: ProposalSourceSchema,

    /** Links back to the audit engine's Finding.id when source is 'audit'. */
    findingId: z.string().nullable(),

    hypothesis: z.string().min(1),

    /** The proposed payload, same shape the renderer validates. */
    content: ArmContentSchema,

    /** Human readable change set the admin queue renders as a diff. */
    diff: z.record(z.unknown()).default({}),

    impactScore: z.number().int().min(0).max(100).nullable(),

    status: ProposalStatusSchema,

    decidedAt: TimestampSchema.nullable(),
    decidedBy: z.string().nullable(),

    armId: UuidSchema.nullable(),

    createdAt: TimestampSchema,
    updatedAt: TimestampSchema,
  })
  .refine((p) => p.status === "pending" || (p.decidedAt !== null && p.decidedBy !== null), {
    message: "a decided proposal records who decided it and when",
    path: ["decidedBy"],
  });

export type Proposal = z.infer<typeof ProposalSchema>;
export type ProposalStatus = z.infer<typeof ProposalStatusSchema>;
export type ProposalSource = z.infer<typeof ProposalSourceSchema>;
