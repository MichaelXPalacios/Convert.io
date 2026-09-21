import { load, type CheerioAPI } from "cheerio";

export type Signal = {
  id: string;
  label: string;
  status: "pass" | "warn" | "fail";
  detail: string;
  evidence?: string;
};

export type PageFacts = {
  url: string;
  title: string;
  metaDescription: string;
  h1s: string[];
  h2s: string[];
  ctas: { text: string; href: string; aboveFold: boolean }[];
  formFields: { name: string; type: string; required: boolean }[];
  navLinks: number;
  images: { src: string; alt: string; hasDims: boolean; lazy: boolean }[];
  scripts: { src: string; async: boolean; defer: boolean; thirdParty: boolean }[];
  wordCount: number;
  heroCopy: string;
  proofTerms: string[];
  priceMentions: string[];
  htmlBytes: number;
  signals: Signal[];
};

const THIRD_PARTY_HINTS = [
  "googletagmanager",
  "google-analytics",
  "facebook.net",
  "hotjar",
  "intercom",
  "segment",
  "hubspot",
  "drift",
  "clarity.ms",
  "tiktok",
  "linkedin",
  "doubleclick",
];

const PROOF_PATTERNS = [
  /\b\d+(?:,\d{3})*\+?\s*(?:customers|teams|companies|users|contractors|stores)\b/gi,
  /\b\d+(?:\.\d+)?x\s*(?:faster|more|higher|better)\b/gi,
  /\b\d+%\s*(?:increase|lift|more|faster|higher|reduction)\b/gi,
  /\b(?:trusted by|rated|reviews?|testimonial|case study)\b/gi,
];

const PRICE_PATTERNS = [/\$\s?\d[\d,]*(?:\.\d{2})?/g, /\bfree (?:trial|forever|plan)\b/gi];

function textOf($: CheerioAPI, sel: string): string[] {
  return $(sel)
    .map((_, el) => $(el).text().replace(/\s+/g, " ").trim())
    .get()
    .filter(Boolean);
}

export function extractFacts(url: string, html: string): PageFacts {
  const $ = load(html);
  $("script, style, noscript").each((_, el) => {
    if (el.tagName === "style" || el.tagName === "noscript") $(el).remove();
  });

  const bodyText = $("body").text().replace(/\s+/g, " ").trim();
  const h1s = textOf($, "h1");
  const h2s = textOf($, "h2");

  const ctas = $("a[href], button")
    .map((i, el) => {
      const text = $(el).text().replace(/\s+/g, " ").trim();
      const href = $(el).attr("href") ?? "";
      const cls = ($(el).attr("class") ?? "").toLowerCase();
      const looksLikeCta =
        /btn|button|cta|primary|signup|sign-up|start|demo|buy|trial|get-/.test(cls) ||
        /^(get|start|try|book|buy|request|schedule|see|claim|join)\b/i.test(text);
      return looksLikeCta && text.length > 0 && text.length < 60
        ? { text, href, aboveFold: i < 12 }
        : null;
    })
    .get()
    .filter(Boolean) as PageFacts["ctas"];

  const formFields = $("input, select, textarea")
    .map((_, el) => ({
      name: $(el).attr("name") ?? $(el).attr("id") ?? "unnamed",
      type: $(el).attr("type") ?? el.tagName,
      required: $(el).attr("required") !== undefined,
    }))
    .get()
    .filter((f) => !["hidden", "submit", "button"].includes(f.type));

  const images = $("img")
    .map((_, el) => ({
      src: $(el).attr("src") ?? $(el).attr("data-src") ?? "",
      alt: $(el).attr("alt") ?? "",
      hasDims: Boolean($(el).attr("width") && $(el).attr("height")),
      lazy: $(el).attr("loading") === "lazy",
    }))
    .get();

  const scripts = $("script[src]")
    .map((_, el) => {
      const src = $(el).attr("src") ?? "";
      return {
        src,
        async: $(el).attr("async") !== undefined,
        defer: $(el).attr("defer") !== undefined,
        thirdParty: THIRD_PARTY_HINTS.some((h) => src.includes(h)),
      };
    })
    .get();

  const proofTerms = PROOF_PATTERNS.flatMap((re) => bodyText.match(re) ?? []);
  const priceMentions = PRICE_PATTERNS.flatMap((re) => bodyText.match(re) ?? []);

  const facts: PageFacts = {
    url,
    title: $("title").first().text().trim(),
    metaDescription: $('meta[name="description"]').attr("content")?.trim() ?? "",
    h1s,
    h2s,
    ctas,
    formFields,
    navLinks: $("nav a, header a").length,
    images,
    scripts,
    wordCount: bodyText.split(/\s+/).length,
    heroCopy: bodyText.slice(0, 900),
    proofTerms: [...new Set(proofTerms)],
    priceMentions: [...new Set(priceMentions)],
    htmlBytes: Buffer.byteLength(html, "utf8"),
    signals: [],
  };

  facts.signals = runSignals(facts, $);
  return facts;
}

function runSignals(f: PageFacts, $: CheerioAPI): Signal[] {
  const s: Signal[] = [];
  const push = (
    id: string,
    label: string,
    ok: boolean,
    failDetail: string,
    passDetail: string,
    hard = true,
    evidence?: string,
  ) =>
    s.push({
      id,
      label,
      status: ok ? "pass" : hard ? "fail" : "warn",
      detail: ok ? passDetail : failDetail,
      evidence,
    });

  push(
    "h1-present",
    "Single clear H1",
    f.h1s.length === 1,
    f.h1s.length === 0
      ? "No H1 on the page. Nothing states the offer in the document outline."
      : `${f.h1s.length} H1 elements compete for the main claim.`,
    "One H1 states the primary claim.",
    true,
    f.h1s[0],
  );

  const headline = f.h1s[0] ?? "";
  const vague =
    /next generation|revolutioniz|cutting.edge|world.class|innovat|transform your|unlock|empower/i.test(
      headline,
    );
  push(
    "h1-specific",
    "Headline names an outcome",
    Boolean(headline) && !vague && headline.split(/\s+/).length <= 14,
    "Headline uses category language instead of naming what the visitor gets.",
    "Headline names a concrete outcome.",
    true,
    headline,
  );

  push(
    "cta-above-fold",
    "Primary CTA reachable immediately",
    f.ctas.some((c) => c.aboveFold),
    "No call to action appears early in the document.",
    "A call to action appears early.",
    true,
    f.ctas[0]?.text,
  );

  const ctaLabels = new Set(f.ctas.map((c) => c.text.toLowerCase()));
  push(
    "cta-consistent",
    "One CTA action, repeated",
    ctaLabels.size > 0 && ctaLabels.size <= 3,
    `${ctaLabels.size} distinct call to action labels split visitor intent.`,
    "Call to action wording stays consistent.",
    false,
    [...ctaLabels].slice(0, 6).join(" / "),
  );

  push(
    "form-short",
    "Form asks for little",
    f.formFields.length <= 4,
    `${f.formFields.length} form fields. Each additional field costs completions.`,
    `${f.formFields.length} form fields.`,
    false,
    f.formFields.map((x) => x.name).join(", "),
  );

  push(
    "nav-leaks",
    "Navigation does not leak attention",
    f.navLinks <= 8,
    `${f.navLinks} navigation links give visitors somewhere else to go.`,
    "Navigation is restrained.",
    false,
  );

  push(
    "proof-present",
    "Proof on the page",
    f.proofTerms.length > 0,
    "No reviews, counts, named customers or outcome numbers found.",
    `Proof signals found: ${f.proofTerms.slice(0, 3).join("; ")}`,
    true,
  );

  push(
    "price-visible",
    "Pricing addressed",
    f.priceMentions.length > 0,
    "No pricing or cost signal. Visitors who need it must leave to find it.",
    `Pricing signals: ${f.priceMentions.slice(0, 3).join(", ")}`,
    false,
  );

  const heroImg = f.images[0];
  push(
    "img-dims",
    "Images reserve their space",
    f.images.every((i) => i.hasDims || i.lazy),
    "Images without width and height push layout during load, which hurts CLS.",
    "Images declare dimensions.",
    false,
  );

  push(
    "hero-not-lazy",
    "Hero image loads eagerly",
    !heroImg || !heroImg.lazy,
    "The first image is lazy loaded, which usually delays the LCP element.",
    "The first image is not lazy loaded.",
    true,
    heroImg?.src,
  );

  const blocking = f.scripts.filter((x) => !x.async && !x.defer);
  push(
    "scripts-nonblocking",
    "Scripts do not block render",
    blocking.length === 0,
    `${blocking.length} render blocking scripts.`,
    "All scripts are async or deferred.",
    false,
    blocking
      .slice(0, 4)
      .map((x) => x.src)
      .join(", "),
  );

  const third = f.scripts.filter((x) => x.thirdParty);
  push(
    "third-party-weight",
    "Third party scripts under control",
    third.length <= 3,
    `${third.length} third party scripts. Each one is main thread time before the visitor can act.`,
    `${third.length} third party scripts.`,
    false,
    third.map((x) => new URL(x.src, f.url).hostname).join(", "),
  );

  push(
    "viewport",
    "Mobile viewport set",
    $('meta[name="viewport"]').length > 0,
    "No viewport meta tag. The page renders at desktop width on phones.",
    "Viewport meta tag present.",
    true,
  );

  push(
    "title-length",
    "Title is usable in search",
    f.title.length >= 15 && f.title.length <= 60,
    `Title is ${f.title.length} characters.`,
    "Title length is reasonable.",
    false,
    f.title,
  );

  push(
    "meta-desc",
    "Meta description present",
    f.metaDescription.length > 50,
    "Missing or very short meta description, so search and social previews are generated at random.",
    "Meta description present.",
    false,
  );

  const alts = f.images.filter((i) => !i.alt).length;
  push(
    "img-alt",
    "Images have alt text",
    alts === 0,
    `${alts} images without alt text.`,
    "All images have alt text.",
    false,
  );

  return s;
}
