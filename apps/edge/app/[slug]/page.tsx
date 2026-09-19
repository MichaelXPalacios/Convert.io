/**
 * The variant page.
 *
 * Middleware has already chosen the arm and set the cookies; this reads the
 * choice off the request header and renders it. The page never allocates,
 * because a Server Component cannot set the cookie that makes an allocation
 * stick, and an assignment the visitor is not carrying is not an assignment.
 *
 * Dynamic by necessity: every request reads per-visitor headers, so there is
 * nothing here to prerender.
 *
 * No `runtime = "edge"` export: Next 16 deprecates the edge runtime in favour
 * of the Node one. Nothing on this path needed it -- the Upstash client is REST
 * over fetch precisely so it does not depend on which runtime it lands in.
 */

import type { Metadata } from "next";
import { headers } from "next/headers";
import { notFound } from "next/navigation";
import { ArmPage } from "../../components/ArmPage";
import { hasContentFor, loadArmContent } from "../../lib/content";
import { ARM_HEADER } from "../../lib/headers";

export const dynamic = "force-dynamic";

const CONTROL_KEY = "control";

/**
 * The arm to render.
 *
 * Falls back to the control whenever the chosen arm has no payload in this
 * deployment, which happens legitimately: the worker can put an arm in the
 * mirror before its content has shipped. Rendering the control is better than
 * a 404 for a visitor who clicked an ad.
 */
async function resolveContent(slug: string) {
  const requested = (await headers()).get(ARM_HEADER) ?? CONTROL_KEY;

  const chosen = loadArmContent(slug, requested);
  if (chosen !== undefined) return chosen;

  if (requested !== CONTROL_KEY) {
    console.warn(`[cv] no content for "${slug}/${requested}", falling back to the control`);
    return loadArmContent(slug, CONTROL_KEY);
  }

  return undefined;
}

export async function generateMetadata({
  params,
}: {
  params: Promise<{ slug: string }>;
}): Promise<Metadata> {
  const { slug } = await params;
  const content = await resolveContent(slug);

  if (content === undefined) return {};

  return {
    title: content.meta.title,
    description: content.meta.description,
  };
}

export default async function Page({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;

  // A slug this deployment carries no content for is a genuine 404. A slug it
  // does carry, whose specific arm is missing, fell back to the control above.
  if (!hasContentFor(slug)) notFound();

  const content = await resolveContent(slug);
  if (content === undefined) notFound();

  return <ArmPage content={content} />;
}
