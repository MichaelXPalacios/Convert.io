#!/usr/bin/env node
//
// Development seed.
//
// Writes one running experiment with a control and two variants, a uniform
// prior for each arm, and the decisions rows that explain where they came
// from. Re-running it is a no-op: every insert is guarded on the same unique
// constraints the schema already enforces, and a decisions row is written only
// for a row this run actually created.
//
//   node --env-file=.env.local db/seed.mjs
//
// It refuses to touch a production branch unless you say --force, because demo
// traffic in a real experiment is not a mistake you can undo with a DELETE:
// the posteriors computed from it have already been read by the edge.

import pg from "pg";

const FORCE = process.argv.includes("--force");

// DDL and multi-statement transactions take the direct connection for the same
// reason migrations do: a transaction pooler is unreliable for both.
const connectionString = process.env.DATABASE_URL_UNPOOLED ?? process.env.DATABASE_URL;

if (!connectionString) {
  console.error(
    "No database URL. Set DATABASE_URL_UNPOOLED (preferred) or DATABASE_URL.\n" +
      "Local runs read .env.local via: node --env-file=.env.local db/seed.mjs",
  );
  process.exit(1);
}

const branch = process.env.NEON_BRANCH ?? "unknown";

if (/^(production|prod|main)$/i.test(branch) && !FORCE) {
  console.error(
    `Refusing to seed branch "${branch}".\n\n` +
      "Seed data becomes exposures and posteriors that the edge will read and act on,\n" +
      "and deleting the rows afterwards does not undo the allocations they produced.\n" +
      "Point NEON_BRANCH at a development branch, or pass --force if you are certain.",
  );
  process.exit(1);
}

const EXPERIMENT = {
  slug: "demo-landing",
  name: "Demo landing page",
  status: "running",
};

// The control is the customer's existing page. It is never retired and never
// paused, which the schema enforces; it is listed first here for the same
// reason, so a reader sees what is being compared against.
const ARMS = [
  {
    key: "control",
    name: "Existing page",
    isControl: true,
    contentRef: "content/arms/demo-landing/control.json",
    allocation: 0.34,
  },
  {
    key: "variant-a",
    name: "Benefit-led headline",
    isControl: false,
    contentRef: "content/arms/demo-landing/variant-a.json",
    allocation: 0.33,
  },
  {
    key: "variant-b",
    name: "Single call to action",
    isControl: false,
    contentRef: "content/arms/demo-landing/variant-b.json",
    allocation: 0.33,
  },
];

// A uniform Beta(1, 1): no evidence yet, every arm equally plausible. The
// interval is the 95% credible interval of that prior, not a placeholder, so
// the admin surface shows an honest "we do not know" on a fresh experiment.
const PRIOR = { alpha: 1, beta: 1, mean: 0.5, ciLow: 0.025, ciHigh: 0.975 };

const ACTOR = "system:seed";

async function main() {
  const client = new pg.Client({ connectionString });
  await client.connect();

  const created = { experiment: false, arms: [], posteriors: 0, decisions: 0 };

  try {
    await client.query("BEGIN");

    // ---- experiment ------------------------------------------------------
    const ins = await client.query(
      `INSERT INTO experiments (slug, name, status)
       VALUES ($1, $2, $3)
       ON CONFLICT (slug) DO NOTHING
       RETURNING id`,
      [EXPERIMENT.slug, EXPERIMENT.name, EXPERIMENT.status],
    );

    let experimentId;

    if (ins.rows.length > 0) {
      experimentId = ins.rows[0].id;
      created.experiment = true;

      await client.query(
        `INSERT INTO decisions (experiment_id, action, reason, actor)
         VALUES ($1, 'create_experiment', $2, $3)`,
        [experimentId, `Seeded "${EXPERIMENT.name}" for local development.`, ACTOR],
      );
      created.decisions += 1;
    } else {
      const found = await client.query("SELECT id FROM experiments WHERE slug = $1", [
        EXPERIMENT.slug,
      ]);
      experimentId = found.rows[0].id;
    }

    // ---- arms ------------------------------------------------------------
    for (const arm of ARMS) {
      const armIns = await client.query(
        `INSERT INTO arms (experiment_id, key, name, is_control, content_ref)
         VALUES ($1, $2, $3, $4, $5)
         ON CONFLICT (experiment_id, key) DO NOTHING
         RETURNING id`,
        [experimentId, arm.key, arm.name, arm.isControl, arm.contentRef],
      );

      let armId;

      if (armIns.rows.length > 0) {
        armId = armIns.rows[0].id;
        created.arms.push(arm.key);

        await client.query(
          `INSERT INTO decisions (experiment_id, arm_id, action, reason, actor)
           VALUES ($1, $2, 'create_arm', $3, $4)`,
          [
            experimentId,
            armId,
            arm.isControl
              ? "Control arm: the existing page, seeded as the comparison baseline."
              : `Variant "${arm.name}", seeded for local development.`,
            ACTOR,
          ],
        );
        created.decisions += 1;
      } else {
        const found = await client.query(
          "SELECT id FROM arms WHERE experiment_id = $1 AND key = $2",
          [experimentId, arm.key],
        );
        armId = found.rows[0].id;
      }

      const post = await client.query(
        `INSERT INTO posteriors
           (experiment_id, arm_id, alpha, beta, mean, ci_low, ci_high, allocation)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
         ON CONFLICT (experiment_id, arm_id) DO NOTHING
         RETURNING arm_id`,
        [
          experimentId,
          armId,
          PRIOR.alpha,
          PRIOR.beta,
          PRIOR.mean,
          PRIOR.ciLow,
          PRIOR.ciHigh,
          arm.allocation,
        ],
      );

      created.posteriors += post.rows.length;
    }

    await client.query("COMMIT");
  } catch (err) {
    await client.query("ROLLBACK");
    throw new Error(`seed failed and was rolled back: ${err.message}`);
  } finally {
    await client.end();
  }

  const nothing =
    !created.experiment &&
    created.arms.length === 0 &&
    created.posteriors === 0 &&
    created.decisions === 0;

  if (nothing) {
    console.log(`Already seeded on branch "${branch}". Nothing to do.`);
    return;
  }

  console.log(`Seeded branch "${branch}":`);
  console.log(`  experiment  ${created.experiment ? EXPERIMENT.slug : "(already present)"}`);
  console.log(`  arms        ${created.arms.length > 0 ? created.arms.join(", ") : "(none new)"}`);
  console.log(`  posteriors  ${created.posteriors}`);
  console.log(`  decisions   ${created.decisions}`);
}

main().catch((err) => {
  console.error(`\n${err.message}`);
  process.exit(1);
});
