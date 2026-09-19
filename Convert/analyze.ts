import Anthropic from "@anthropic-ai/sdk";
import type { PageFacts } from "./heuristics.js";

export type Finding = {
  id: string;
  area: "message" | "conversion path" | "trust" | "performance" | "targeting";
  title: string;
  current: string;
  problem: string;
  suggested: string;
  hypothesis: string;
  expectedEffect: string;
  confidence: "high" | "medium" | "low";
  effort: "S" | "M" | "L";
  impactScore: number;
  armable: boolean;
};

export type Analysis = {
  summary: string;
  audienceRead: string;
  biggestLeak: string;
  findings: Finding[];
};

const SYSTEM = `You are a conversion rate analyst. You are given structured facts scraped from a landing page plus the results of deterministic checks already run against it.

Rules:
- Never invent facts about the business. Work only from the supplied facts. If something is unknown, say it is unknown.
- Never repeat a deterministic signal as a finding unless you can say why it costs conversions on THIS page.
- Every finding must be testable as a landing page variant, or explicitly marked armable: false when it is an engineering or offer change.
- Rank by expected revenue impact, not by severity or by how easy it is to describe.
- impactScore is 0 to 100 and must reflect (reach on the page) x (likely effect size) x (confidence). Reserve above 70 for changes you expect to move conversion by a fifth or more.
- Write "current" as a short quote or description of what is there now. No praise, no filler.
- Suggested copy must be specific enough to ship. "Clarify the value proposition" is not a suggestion; a written headline is.

Return ONLY valid JSON matching the requested shape. No markdown fences, no preamble.`;

export async function analyze(facts: PageFacts, context: string): Promise<Analysis> {
  const client = new Anthropic();

  const failed = facts.signals.filter((s) => s.status !== "pass");

  const prompt = `Page under review: ${facts.url}

Business context supplied by the operator (may be empty):
${context || "(none supplied)"}

FACTS
title: ${facts.title}
meta description: ${facts.metaDescription || "(none)"}
h1: ${JSON.stringify(facts.h1s)}
h2s: ${JSON.stringify(facts.h2s.slice(0, 12))}
calls to action: ${JSON.stringify(facts.ctas.slice(0, 10))}
form fields: ${JSON.stringify(facts.formFields)}
nav link count: ${facts.navLinks}
proof terms found: ${JSON.stringify(facts.proofTerms)}
price mentions: ${JSON.stringify(facts.priceMentions)}
image count: ${facts.images.length}, scripts: ${facts.scripts.length}, third party: ${facts.scripts.filter((s) => s.thirdParty).length}
word count: ${facts.wordCount}, html size: ${Math.round(facts.htmlBytes / 1024)} KB

OPENING COPY
${facts.heroCopy}

FAILED OR WARNING CHECKS
${failed.map((s) => `- [${s.status}] ${s.label}: ${s.detail}${s.evidence ? ` (evidence: ${s.evidence})` : ""}`).join("\n")}

Return JSON:
{
  "summary": "three sentences max, what this page is doing and where it loses people",
  "audienceRead": "who this page appears written for, and whether the copy matches that reader",
  "biggestLeak": "the single highest leverage change, one sentence",
  "findings": [
    {
      "id": "kebab-case-id",
      "area": "message | conversion path | trust | performance | targeting",
      "title": "short",
      "current": "what is there now",
      "problem": "why it costs conversions",
      "suggested": "specific shippable change, including exact copy where relevant",
      "hypothesis": "if we do X then Y because Z",
      "expectedEffect": "what metric moves and roughly how much",
      "confidence": "high | medium | low",
      "effort": "S | M | L",
      "impactScore": 0,
      "armable": true
    }
  ]
}

Return between 5 and 9 findings, sorted by impactScore descending.`;

  const res = await client.messages.create({
    model: "claude-sonnet-4-6",
    max_tokens: 6000,
    system: SYSTEM,
    messages: [{ role: "user", content: prompt }],
  });

  const text = res.content
    .filter((b): b is Anthropic.TextBlock => b.type === "text")
    .map((b) => b.text)
    .join("")
    .replace(/^```(?:json)?/gm, "")
    .replace(/```$/gm, "")
    .trim();

  try {
    const parsed = JSON.parse(text) as Analysis;
    parsed.findings.sort((a, b) => b.impactScore - a.impactScore);
    return parsed;
  } catch (err) {
    throw new Error(
      `Model did not return parseable JSON: ${(err as Error).message}\n\n${text.slice(0, 500)}`,
    );
  }
}
