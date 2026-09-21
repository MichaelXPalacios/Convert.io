import type { Analysis, Finding } from "./analyze.js";
import type { PageFacts } from "./heuristics.js";

const bar = (n: number) => "\u2588".repeat(Math.round(n / 10)).padEnd(10, "\u2591");

export function feedbackReport(facts: PageFacts, a: Analysis): string {
  const host = new URL(facts.url).hostname;
  const armable = a.findings.filter((f) => f.armable);

  return `# Conversion review: ${host}

Reviewed ${new Date().toISOString().slice(0, 10)} against ${facts.url}

## What we found

${a.summary}

**Who the page speaks to.** ${a.audienceRead}

**Biggest leak.** ${a.biggestLeak}

## Ranked findings

${a.findings.map((f, i) => findingBlock(f, i + 1)).join("\n\n")}

## Automated checks

| Check | Result | Detail |
| --- | --- | --- |
${facts.signals
  .map(
    (s) =>
      `| ${s.label} | ${s.status === "pass" ? "pass" : s.status === "warn" ? "warn" : "fail"} | ${s.detail.replace(/\|/g, "/")} |`,
  )
  .join("\n")}

## What we would test first

${armable
  .slice(0, 3)
  .map((f, i) => `${i + 1}. **${f.title}** \u2014 ${f.hypothesis}`)
  .join("\n")}

Each of these runs as a live variant against your current page. Your current page stays in rotation as the control, so the comparison is measured rather than asserted.

---

Prepared by Convert.io. Questions on any finding get a straight answer, not a sales call.
`;
}

function findingBlock(f: Finding, n: number): string {
  return `### ${n}. ${f.title}

\`${bar(f.impactScore)}\` impact ${f.impactScore}/100 \u00b7 ${f.area} \u00b7 effort ${f.effort} \u00b7 confidence ${f.confidence}

**Now:** ${f.current}

**Why it costs you:** ${f.problem}

**Change to:** ${f.suggested}

**Hypothesis:** ${f.hypothesis}

**Expected:** ${f.expectedEffect}`;
}

export function implementationPlan(facts: PageFacts, a: Analysis): string {
  const host = new URL(facts.url).hostname;
  const armable = a.findings.filter((f) => f.armable);
  const engineering = a.findings.filter((f) => !f.armable);

  const wave = (fs: Finding[], label: string, weeks: string) =>
    fs.length === 0
      ? ""
      : `### ${label} (${weeks})

${fs
  .map(
    (f) => `**${f.title}** \u2014 ${f.effort} effort, impact ${f.impactScore}
- Build: ${f.suggested}
- Arm key: \`${f.id}\`
- Success: ${f.expectedEffect}
- Kill criteria: posterior mean below control's lower credible bound after 1,000 exposures`,
  )
  .join("\n\n")}
`;

  const s = [...armable].sort(
    (a2, b) => b.impactScore / effortWeight(b.effort) - a2.impactScore / effortWeight(a2.effort),
  );
  const wave1 = s.filter((f) => f.effort === "S").slice(0, 3);
  const wave2 = s.filter((f) => f.effort === "M").slice(0, 3);
  const wave3 = s.filter((f) => f.effort === "L");

  return `# Implementation plan: ${host}

Ordered by impact per unit of effort, not by the order they appear on the page.

## Week 0: measurement before changes

Nothing below can be evaluated without this, so it ships first.

- UTM scheme: one \`utm_content\` value per variant, one \`utm_campaign\` per angle.
- Exposure logging: every render writes visitor, session, variant, source, device, timestamp.
- Conversion webhook: your order or lead event posts to the collector with the visitor id, so revenue joins back to the variant that produced it.
- Server side conversion forwarding to Meta and Google, so iOS and ad blockers do not eat the signal.
- Your current page is registered as the control arm. It is never removed from rotation.

Exit criteria: a test purchase or lead appears in the dashboard attributed to the correct variant within 60 seconds.

${wave(wave1, "Wave 1: copy and layout", "week 1")}
${wave(wave2, "Wave 2: structural", "weeks 2 to 3")}
${wave(wave3, "Wave 3: heavier changes", "week 4 onward")}
${
  engineering.length
    ? `### Engineering track (parallel, not variant tested)

${engineering.map((f) => `- **${f.title}**: ${f.suggested} (${f.effort})`).join("\n")}
`
    : ""
}
## How allocation works

Variants run simultaneously. Traffic is allocated by Thompson sampling on revenue per visitor, with a 10 percent exploration floor so nothing starves and a minimum of 1,000 exposures per arm before any arm can be promoted or retired. If a promoted variant regresses below the control's lower credible bound, it is paused automatically and logged with the reason.

## What we need from you

- Read access to your ad accounts and analytics
- The order or lead webhook endpoint, or permission to add one
- Brand rules and any claims legal will not allow
- One person who can approve variant copy

## What you get weekly

Revenue per visitor by variant, click through and conversion split out so an ad problem is distinguishable from a page problem, the current allocation, and the next proposed tests with the reasoning attached.
`;
}

const effortWeight = (e: Finding["effort"]) => (e === "S" ? 1 : e === "M" ? 2 : 4);

export function outreachEmail(facts: PageFacts, a: Analysis): string {
  const host = new URL(facts.url).hostname;
  const top = a.findings[0];

  // An analysis with no findings is a legitimate outcome \u2014 the page may be
  // fine \u2014 and there is no outreach to write about it. Saying so is better
  // than an email with a hole where the finding should be.
  if (top === undefined) {
    return `Subject: ${host} \u2014 conversion review, nothing material found

Hi,

I ran a conversion review on ${host} and found nothing material enough to be
worth changing. ${a.biggestLeak}

Happy to look again if the page changes.`;
  }

  return `Subject: ${host} \u2014 ${top.title.toLowerCase()}

Hi,

I ran a conversion review on ${host}. Not a generic audit, an actual read of the page.

The clearest issue: ${top.problem}

Right now the page says ${JSON.stringify(top.current)}. ${top.suggested}

${a.findings.length - 1} other findings are in the attached review, ranked by what we would expect each to be worth, with an implementation plan that puts measurement in place before any change ships.

Happy to walk through it, or you can take the report and build it yourself. Either is fine.
`;
}
