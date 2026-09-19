/**
 * Next 16 no longer accepts an `eslint` key here, and the repo gates ESLint and
 * Prettier in CI anyway. Type errors still fail the build, which is the check
 * worth having at this stage.
 */

import { existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Load the workspace root `.env.local`.
 *
 * Next resolves env files relative to the app directory, and this app lives at
 * apps/edge while the credentials live at the repository root — one file,
 * written by `neon link`, shared by the migration runner, the seed and the
 * app. So `next dev` and `next start` start with none of it set.
 *
 * That failure is silent and misleading rather than loud: with no Upstash
 * credentials the mirror read fails, selection falls back to the control arm,
 * and local development shows a page that works. You conclude the bandit is
 * not allocating when in fact it was never configured. The only visible hint
 * is a log line about CRON_SECRET.
 *
 * `process.loadEnvFile` is built into Node 22, which this repo already
 * requires, so this costs no dependency. Values already present in the
 * environment win: Vercel injects its own there, and CI sets them explicitly.
 */
const here = dirname(fileURLToPath(import.meta.url));
const rootEnv = resolve(here, "../../.env.local");

if (existsSync(rootEnv)) {
  // A copy of the VALUES, not the keys. Reading them back after the load
  // would read whatever the file just wrote, which would restore nothing.
  const before = { ...process.env };
  try {
    process.loadEnvFile(rootEnv);

    // Re-assert anything that was already set. loadEnvFile overwrites, and an
    // explicitly exported value must beat a file on disk — otherwise pointing
    // a one-off run at a different branch silently does nothing.
    for (const [key, value] of Object.entries(before)) {
      if (value !== undefined) process.env[key] = value;
    }
  } catch (error) {
    // A malformed env file should not take the dev server down, but it must
    // not pass unnoticed either.
    console.warn(`[cv] could not read ${rootEnv}: ${error.message}`);
  }
}

/** @type {import("next").NextConfig} */
const nextConfig = {
  typescript: { ignoreBuildErrors: false },
};

export default nextConfig;
