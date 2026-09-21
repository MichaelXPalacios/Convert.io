# Convert.io audit engine (stage 1)

Fetches a landing page, runs deterministic checks, then asks Claude to turn the
facts into ranked findings. Produces three artifacts you can send a prospect.

## Run

    npm install
    export ANTHROPIC_API_KEY=sk-ant-...
    npm run audit -- --url https://example.com --context "b2c skincare, meta traffic, aov $60"

## Output

    audits/<host>/
      review.md                 prospect facing, ranked findings with evidence
      implementation-plan.md    waves ordered by impact per effort, measurement first
      outreach.txt              cold email built from the top finding
      raw.json                  facts + analysis, feeds the arm generator later

## Why the checks run before the model

Anything deterministic (missing H1, lazy hero image, blocking scripts, form
length) is measured in code, not guessed. The model only reasons about the
things that need judgment: message match, offer clarity, proof placement. This
keeps the findings reproducible and stops the report drifting between runs on
the same page.

## Known limits

- Static fetch only. Client rendered pages return a shell; add a headless
  browser pass before running this against SPAs.
- No Core Web Vitals field data. The performance findings are structural
  (blocking scripts, lazy hero, missing dimensions), not measured timings.
- Findings are hypotheses. None of them are true until an arm proves it.
