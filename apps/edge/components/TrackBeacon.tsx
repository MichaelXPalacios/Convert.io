"use client";

/**
 * The exposure beacon.
 *
 * Posts once per mount to /api/track, which reads the visitor, session and arm
 * from the proxy's HttpOnly cookies and records the exposure. This component
 * therefore sends almost nothing: the slug it is on, and the campaign
 * parameters that are in the URL the visitor arrived with. Everything else --
 * identity, user agent, country, device -- is filled in server-side, because a
 * value the client supplies is a value the client can forge.
 *
 * KNOWN BIAS, recorded here because it is invisible at the call site:
 *
 * Exposures are the denominator of every posterior, and a beacon makes the
 * denominator depend on client JavaScript running. An ad blocker, a no-JS
 * visitor, or a bounce before hydration all mean the visitor saw the arm and
 * no exposure was written. That loss is not uniform across arms -- a variant
 * that hydrates slower loses more of them -- and an arm that under-reports
 * exposures looks better than it is.
 *
 * It is partly self-cancelling: a conversion whose exposure was never recorded
 * attributes to nothing and never reaches a posterior either. Only partly,
 * though, so the loss rate is worth watching once there is traffic to measure
 * it with.
 *
 * Mitigations that are actually in place: it fires in an effect with no
 * dependencies (as early as the client can), it uses keepalive so a visitor
 * who navigates away mid-flight still delivers it, and the exposure write is
 * idempotent on (visitor, session, arm), so firing twice costs nothing and a
 * retry is always safe.
 */

import { useEffect, useRef } from "react";

/** Campaign parameters, as the platforms spell them. */
const UTM_PARAMS = ["source", "medium", "campaign", "content", "term"] as const;

export function TrackBeacon({ slug }: { slug: string }) {
  // Strict Mode mounts twice in development. The write is idempotent so a
  // double fire is harmless, but there is no reason to spend the round trip.
  const fired = useRef(false);

  useEffect(() => {
    if (fired.current) return;
    fired.current = true;

    const params = new URLSearchParams(window.location.search);
    const utm: Record<string, string> = {};
    for (const name of UTM_PARAMS) {
      const value = params.get(`utm_${name}`);
      if (value !== null && value !== "") {
        utm[`utm${name.charAt(0).toUpperCase()}${name.slice(1)}`] = value;
      }
    }

    void fetch("/api/track", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        slug,
        referrer: document.referrer === "" ? undefined : document.referrer,
        ...utm,
      }),
      // The visitor may leave immediately; this is exactly the case keepalive
      // exists for, and losing the exposure of a bounce would bias against
      // whichever arm bounces most.
      keepalive: true,
      // Nothing is read back. A failure costs one data point and must never
      // cost the visitor their page.
    }).catch(() => undefined);
  }, [slug]);

  return null;
}
