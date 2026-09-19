import { z } from "zod";
import { SlugSchema, UuidSchema } from "./common.js";
import { ArmStatusSchema } from "./arm.js";

/**
 * The posterior mirror.
 *
 * This format lives in contracts rather than in the worker because it is the
 * one thing the worker writes and the edge reads, and a key format invented
 * independently on both sides is the classic way parallel work produces two
 * systems that each pass their own tests.
 *
 * Layout: one Redis HASH per experiment slug, so the edge does exactly one
 * HGETALL on the hot path. Fields are arm keys, plus a reserved `__meta` field
 * carrying the experiment-level guardrail values so the edge never needs a
 * database read to allocate.
 */

export const REDIS_MIRROR_SCHEMA_VERSION = 1;
export const REDIS_POSTERIOR_KEY_PREFIX = "cv:post:v1";
export const REDIS_MIRROR_META_FIELD = "__meta";

/** `cv:post:v1:<slug>` */
export const redisPosteriorKey = (slug: string): string => `${REDIS_POSTERIOR_KEY_PREFIX}:${slug}`;

/** One field of the hash: everything the edge needs to sample one arm. */
export const MirrorArmSchema = z.object({
  armId: UuidSchema,
  key: SlugSchema,
  isControl: z.boolean(),
  status: ArmStatusSchema,
  alpha: z.number().positive(),
  beta: z.number().positive(),
  /** Last computed share. Advisory: the edge samples rather than replaying it. */
  allocation: z.number().min(0).max(1),
  exposuresCount: z.number().int().nonnegative(),
});

/** The reserved `__meta` field. */
export const MirrorMetaSchema = z.object({
  schemaVersion: z.literal(REDIS_MIRROR_SCHEMA_VERSION),
  experimentId: UuidSchema,
  slug: SlugSchema,
  explorationFloor: z.number().gt(0).lt(1),
  minExposures: z.number().int().nonnegative(),
  computedAt: z.string(),
});

export type MirrorArm = z.infer<typeof MirrorArmSchema>;
export type MirrorMeta = z.infer<typeof MirrorMetaSchema>;

export interface PosteriorMirror {
  meta: MirrorMeta;
  arms: MirrorArm[];
}

/**
 * Serialize a mirror into the flat `field -> string` map a Redis HSET takes.
 * The worker calls this; nothing else should be constructing these fields.
 */
export function serializePosteriorMirror(mirror: PosteriorMirror): Record<string, string> {
  const out: Record<string, string> = {
    [REDIS_MIRROR_META_FIELD]: JSON.stringify(MirrorMetaSchema.parse(mirror.meta)),
  };
  for (const arm of mirror.arms) {
    out[arm.key] = JSON.stringify(MirrorArmSchema.parse(arm));
  }
  return out;
}

/**
 * Parse an HGETALL result back into a mirror.
 *
 * Throws on a malformed or absent `__meta`, because allocating without the
 * guardrail values is worse than failing: the caller can fall back to the
 * control arm, but it cannot invent a floor it never read.
 */
export function parsePosteriorMirror(hash: Record<string, string>): PosteriorMirror {
  const rawMeta = hash[REDIS_MIRROR_META_FIELD];
  if (rawMeta === undefined) {
    throw new Error(`posterior mirror is missing its ${REDIS_MIRROR_META_FIELD} field`);
  }

  const meta = MirrorMetaSchema.parse(JSON.parse(rawMeta));

  const arms: MirrorArm[] = [];
  for (const [field, value] of Object.entries(hash)) {
    if (field === REDIS_MIRROR_META_FIELD) continue;
    arms.push(MirrorArmSchema.parse(JSON.parse(value)));
  }

  return { meta, arms };
}
