/**
 * Next 16 no longer accepts an `eslint` key here, and the repo gates ESLint and
 * Prettier in CI anyway. Type errors still fail the build, which is the check
 * worth having at this stage.
 */
/** @type {import("next").NextConfig} */
const nextConfig = {
  typescript: { ignoreBuildErrors: false },
};

export default nextConfig;
