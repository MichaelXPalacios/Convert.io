/**
 * Arm content.
 *
 * `arms.content_ref` in the schema points at content/arms/<slug>/<key>.json,
 * and this is the edge's view of those files. They are imported statically
 * rather than read from disk because the edge runtime has no filesystem, and
 * because a payload that ships with the deployment cannot drift from the code
 * that renders it.
 *
 * Every payload is validated against ArmContentSchema before it reaches a
 * component. A variant we generated ourselves shipping a malformed section is
 * a bug we would rather find at the first request than halfway down a page.
 */

import { ArmContentSchema } from "@convertio/contracts";
import type { ArmContent } from "@convertio/contracts";

import demoControl from "../content/arms/demo-landing/control.json";
import demoVariantA from "../content/arms/demo-landing/variant-a.json";
import demoVariantB from "../content/arms/demo-landing/variant-b.json";

/** Keyed by `<slug>/<key>`, matching the content_ref convention. */
const RAW: Record<string, unknown> = {
  "demo-landing/control": demoControl,
  "demo-landing/variant-a": demoVariantA,
  "demo-landing/variant-b": demoVariantB,
};

const cache = new Map<string, ArmContent>();

/**
 * The content for one arm, or undefined when the deployment carries no payload
 * for it.
 *
 * Undefined is a real possibility rather than an error: the worker can put an
 * arm in the mirror before its content has shipped. The caller falls back to
 * the control, which is why this returns rather than throws.
 */
export function loadArmContent(slug: string, armKey: string): ArmContent | undefined {
  const ref = `${slug}/${armKey}`;

  const cached = cache.get(ref);
  if (cached !== undefined) return cached;

  const raw = RAW[ref];
  if (raw === undefined) return undefined;

  const parsed = ArmContentSchema.safeParse(raw);
  if (!parsed.success) {
    console.error(`[cv] content for "${ref}" failed validation:`, parsed.error.message);
    return undefined;
  }

  cache.set(ref, parsed.data);
  return parsed.data;
}

/** Whether this deployment knows how to render anything for a slug at all. */
export function hasContentFor(slug: string): boolean {
  return Object.keys(RAW).some((ref) => ref.startsWith(`${slug}/`));
}
