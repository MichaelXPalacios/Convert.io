import { z } from "zod";
import { SlugSchema, TimestampSchema, UuidSchema } from "./common.js";

export const ArmStatusSchema = z.enum(["active", "paused", "promoted", "retired"]);

/** A row of `arms`. Mirrors db/001_init.sql exactly. */
export const ArmSchema = z
  .object({
    id: UuidSchema,
    experimentId: UuidSchema,
    key: SlugSchema,
    name: z.string().min(1),
    isControl: z.boolean(),
    status: ArmStatusSchema,
    contentRef: z.string().min(1),
    createdAt: TimestampSchema,
    updatedAt: TimestampSchema,
  })
  .refine((a) => !a.isControl || a.status === "active" || a.status === "promoted", {
    message: "the control arm is never paused and never retired",
    path: ["status"],
  });

export type Arm = z.infer<typeof ArmSchema>;
export type ArmStatus = z.infer<typeof ArmStatusSchema>;

// ---------------------------------------------------------------------------
// Arm content payload
//
// What lives in content/arms/<key>.json and what the variant route renders,
// entirely on the server. If any of this reaches the browser as JSON to be
// applied by client JavaScript, the implementation is wrong.
// ---------------------------------------------------------------------------

export const CtaSchema = z.object({
  label: z.string().min(1).max(60),
  href: z.string().min(1),
  style: z.enum(["solid", "ghost"]).default("solid"),
});

/**
 * Width and height are required, not optional. The audit engine flags images
 * without dimensions because they push layout during load, and a variant we
 * generate ourselves has no excuse for shipping the defect we charge to find.
 */
export const ImageSchema = z.object({
  src: z.string().min(1),
  alt: z.string(),
  width: z.number().int().positive(),
  height: z.number().int().positive(),
});

export const HeroSchema = z.object({
  headline: z.string().min(1),
  lede: z.string().min(1),
  cta: CtaSchema,
  image: ImageSchema.optional(),
});

const ProseSection = z.object({
  kind: z.literal("prose"),
  heading: z.string().min(1),
  sub: z.string().optional(),
  body: z.array(z.string()).default([]),
  cta: CtaSchema.optional(),
});

const StepsSection = z.object({
  kind: z.literal("steps"),
  heading: z.string().min(1),
  sub: z.string().optional(),
  steps: z.array(z.object({ title: z.string().min(1), body: z.string().min(1) })).min(1),
});

const CompareSection = z.object({
  kind: z.literal("compare"),
  heading: z.string().min(1),
  sub: z.string().optional(),
  panes: z
    .array(
      z.object({
        title: z.string().min(1),
        body: z.string().min(1),
        caption: z.string().optional(),
        bars: z
          .array(
            z.object({
              height: z.number().min(0).max(100),
              tone: z.enum(["muted", "live", "win"]),
            }),
          )
          .default([]),
      }),
    )
    .min(2),
});

const FindingSection = z.object({
  kind: z.literal("finding"),
  heading: z.string().min(1),
  sub: z.string().optional(),
  label: z.string().default("Sample finding"),
  impactScore: z.number().int().min(0).max(100),
  area: z.string().min(1),
  effort: z.enum(["S", "M", "L"]),
  now: z.string().min(1),
  why: z.string().min(1),
  change: z.string().min(1),
  expected: z.string().min(1),
});

const FormSection = z.object({
  kind: z.literal("form"),
  heading: z.string().min(1),
  sub: z.string().optional(),
  fields: z
    .array(
      z.object({
        name: z.string().min(1),
        type: z.enum(["url", "email", "text", "tel"]),
        placeholder: z.string().default(""),
        label: z.string().min(1),
        required: z.boolean().default(true),
      }),
    )
    .min(1),
  submitLabel: z.string().min(1),
  fineprint: z.string().optional(),
});

export const SectionSchema = z.discriminatedUnion("kind", [
  ProseSection,
  StepsSection,
  CompareSection,
  FindingSection,
  FormSection,
]);

export const ArmContentSchema = z.object({
  /** Bumped when the shape changes in a way a stored payload cannot satisfy. */
  schemaVersion: z.literal(1),

  key: SlugSchema,
  meta: z.object({
    title: z.string().min(1).max(70),
    description: z.string().min(1).max(200),
  }),
  hero: HeroSchema,
  sections: z.array(SectionSchema).default([]),
  footer: z.object({
    brand: z.string().min(1),
    tagline: z.string().min(1),
  }),
});

export type Cta = z.infer<typeof CtaSchema>;
export type ArmImage = z.infer<typeof ImageSchema>;
export type Hero = z.infer<typeof HeroSchema>;
export type Section = z.infer<typeof SectionSchema>;
export type ArmContent = z.infer<typeof ArmContentSchema>;
