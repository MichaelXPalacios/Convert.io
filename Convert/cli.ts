#!/usr/bin/env node
import { writeFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { extractFacts } from "./heuristics.js";
import { analyze } from "./analyze.js";
import { feedbackReport, implementationPlan, outreachEmail } from "./report.js";

const { values } = parseArgs({
  options: {
    url: { type: "string" },
    context: { type: "string", default: "" },
    out: { type: "string", default: "audits" },
    json: { type: "boolean", default: false },
  },
});

if (!values.url) {
  console.error(
    'usage: convertio-audit --url https://example.com [--context "b2c skincare, meta traffic"]',
  );
  process.exit(1);
}

const url = values.url;

async function main() {
  process.stderr.write(`fetching ${url}\n`);
  const res = await fetch(url, {
    headers: {
      "user-agent": "Mozilla/5.0 (compatible; ConvertioAudit/0.1; +https://convert.io/bot)",
      accept: "text/html,application/xhtml+xml",
    },
    redirect: "follow",
  });

  if (!res.ok) throw new Error(`fetch failed: ${res.status} ${res.statusText}`);
  const html = await res.text();

  const facts = extractFacts(url, html);
  const failed = facts.signals.filter((s) => s.status === "fail").length;
  process.stderr.write(`extracted ${facts.signals.length} checks, ${failed} failing\n`);

  process.stderr.write("analyzing\n");
  const analysis = await analyze(facts, values.context ?? "");

  const slug = new URL(url).hostname.replace(/[^a-z0-9]+/gi, "-");
  const dir = join(values.out!, slug);
  await mkdir(dir, { recursive: true });

  await Promise.all([
    writeFile(join(dir, "review.md"), feedbackReport(facts, analysis)),
    writeFile(join(dir, "implementation-plan.md"), implementationPlan(facts, analysis)),
    writeFile(join(dir, "outreach.txt"), outreachEmail(facts, analysis)),
    writeFile(join(dir, "raw.json"), JSON.stringify({ facts, analysis }, null, 2)),
  ]);

  if (values.json) {
    process.stdout.write(JSON.stringify(analysis, null, 2));
  } else {
    process.stderr.write(
      `\nwrote ${dir}/\n  review.md\n  implementation-plan.md\n  outreach.txt\n  raw.json\n\n`,
    );
    process.stderr.write(
      `top finding: ${analysis.findings[0].title} (${analysis.findings[0].impactScore}/100)\n`,
    );
  }
}

main().catch((err) => {
  console.error(err.message);
  process.exit(1);
});
