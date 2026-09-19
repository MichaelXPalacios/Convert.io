// Neon configuration-as-code.
//
// This file owns the Neon project; terraform/ deliberately does not (see
// versions.tf). One system per resource, so a plan nobody read carefully
// cannot destroy a branch.
//
// What lives here is *policy for branches that do not exist yet*. The branch
// closure runs at create time and returns the settings the new branch is born
// with. Applying it to an existing branch takes an explicit `neon deploy`, and
// the first line of the closure refuses that:
//
//   neon checkout preview/my-feature   # policy applies, branch is created
//   neon deploy                        # reconcile — a no-op here, by design
//
// production and development were created by hand and are managed by hand.
// A closure that reconciled them could silently reparent or expire the branch
// the request path is reading from, which is not a trade worth the tidiness.

import { defineConfig } from "@neon/config/v1";

export default defineConfig({
  branch: (branch) => {
    // Never reconcile a branch that already exists. Every field below is
    // reachable only on the create path.
    if (branch.exists) return {};

    // Ephemeral branches: one per pull request, one per experiment, one per
    // developer who wants to break something.
    //
    // They are parented on development rather than production on purpose.
    // A preview deployment of a bandit is a live experiment, and production
    // rows are real visitors and real orders; copying them into a branch that
    // a preview deployment will write exposures and posteriors into mixes
    // demo traffic with revenue data that cannot be un-mixed afterwards.
    // development already carries the seed, which is what a preview needs.
    //
    // When you genuinely want production-shaped data — testing a migration
    // against real row volumes, say — create that branch explicitly off
    // production and delete it when you are done:
    //
    //   neon branches create --name migration-test --parent production \
    //     --expires-at <iso8601>
    if (/^(preview|pr|dev)[/-]/.test(branch.name)) {
      return {
        parent: "development",

        // The Neon API caps expiry at 30 days. A week is longer than any pull
        // request should be open and short enough that an abandoned one stops
        // costing storage without anyone remembering to clean it up.
        ttl: "7d",

        postgres: {
          computeSettings: {
            // Scale to zero. A throwaway branch is idle almost all the time.
            autoscalingLimitMinCu: 0.25,
            // Half of what production is allowed. A preview that needs more
            // than 1 CU is measuring something that belongs on its own branch.
            autoscalingLimitMaxCu: 1,
            suspendTimeout: "5m",
          },
        },
      };
    }

    // Anything else inherits the project defaults: 0.25–2 CU, scale to zero,
    // no expiry.
    //
    // `protected: true` on the default branch is the obvious thing to want
    // here and is deliberately absent: this project is on the free plan, which
    // allows zero protected branches, so the policy would fail at apply rather
    // than protect anything. Set it when the plan changes.
    return {};
  },
});
