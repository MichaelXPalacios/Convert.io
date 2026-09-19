/**
 * The variant renderer.
 *
 * Every section is rendered on the server from the validated payload. Nothing
 * here ships arm content to the browser as JSON to be applied by client
 * JavaScript: that would put the variant behind a render delay, make the page
 * flash the control first, and hand the measurement a confound it cannot see.
 *
 * There is no "use client" in this file, and there should not be one.
 */

import type { ArmContent, Cta, Section } from "@convertio/contracts";

function CtaLink({ cta }: { cta: Cta }) {
  return (
    <a className={`cta cta--${cta.style}`} href={cta.href}>
      {cta.label}
    </a>
  );
}

function Prose({ section }: { section: Extract<Section, { kind: "prose" }> }) {
  return (
    <section className="section">
      <h2>{section.heading}</h2>
      {section.sub !== undefined && <p className="sub">{section.sub}</p>}
      {section.body.map((paragraph, i) => (
        <p key={i}>{paragraph}</p>
      ))}
      {section.cta !== undefined && <CtaLink cta={section.cta} />}
    </section>
  );
}

function Steps({ section }: { section: Extract<Section, { kind: "steps" }> }) {
  return (
    <section className="section">
      <h2>{section.heading}</h2>
      {section.sub !== undefined && <p className="sub">{section.sub}</p>}
      <ol className="steps">
        {section.steps.map((step) => (
          <li key={step.title}>
            <h3>{step.title}</h3>
            <p>{step.body}</p>
          </li>
        ))}
      </ol>
    </section>
  );
}

function Compare({ section }: { section: Extract<Section, { kind: "compare" }> }) {
  return (
    <section className="section">
      <h2>{section.heading}</h2>
      {section.sub !== undefined && <p className="sub">{section.sub}</p>}
      <div className="panes">
        {section.panes.map((pane) => (
          <article key={pane.title} className="pane">
            <h3>{pane.title}</h3>
            <p>{pane.body}</p>
            {pane.bars.length > 0 && (
              <div className="bars" aria-hidden="true">
                {pane.bars.map((bar, i) => (
                  <span
                    key={i}
                    className={`bar bar--${bar.tone}`}
                    style={{ height: `${bar.height}%` }}
                  />
                ))}
              </div>
            )}
            {pane.caption !== undefined && <p className="caption">{pane.caption}</p>}
          </article>
        ))}
      </div>
    </section>
  );
}

function Finding({ section }: { section: Extract<Section, { kind: "finding" }> }) {
  return (
    <section className="section">
      <h2>{section.heading}</h2>
      {section.sub !== undefined && <p className="sub">{section.sub}</p>}
      <article className="finding">
        <header>
          <span className="tag">{section.label}</span>
          <span className="tag tag--muted">{section.area}</span>
          <span className="tag tag--muted">Effort {section.effort}</span>
          <span className="score">Impact {section.impactScore}</span>
        </header>
        <dl>
          <dt>Now</dt>
          <dd>{section.now}</dd>
          <dt>Why it costs</dt>
          <dd>{section.why}</dd>
          <dt>Change</dt>
          <dd>{section.change}</dd>
          <dt>Expected</dt>
          <dd>{section.expected}</dd>
        </dl>
      </article>
    </section>
  );
}

/**
 * The form posts to a normal endpoint and works without JavaScript. The audit
 * request is the conversion this page exists to produce, so it must not depend
 * on a script that may not have loaded yet.
 */
function Form({ section }: { section: Extract<Section, { kind: "form" }> }) {
  return (
    <section className="section" id="audit">
      <h2>{section.heading}</h2>
      {section.sub !== undefined && <p className="sub">{section.sub}</p>}
      <form className="form" method="post" action="/api/audit">
        {section.fields.map((field) => (
          <label key={field.name}>
            <span>{field.label}</span>
            <input
              name={field.name}
              type={field.type}
              placeholder={field.placeholder}
              required={field.required}
            />
          </label>
        ))}
        <button type="submit">{section.submitLabel}</button>
        {section.fineprint !== undefined && <p className="fineprint">{section.fineprint}</p>}
      </form>
    </section>
  );
}

function SectionView({ section }: { section: Section }) {
  switch (section.kind) {
    case "prose":
      return <Prose section={section} />;
    case "steps":
      return <Steps section={section} />;
    case "compare":
      return <Compare section={section} />;
    case "finding":
      return <Finding section={section} />;
    case "form":
      return <Form section={section} />;
  }
}

export function ArmPage({ content }: { content: ArmContent }) {
  const { hero, footer } = content;

  return (
    <main>
      <section className="hero">
        <h1>{hero.headline}</h1>
        <p className="lede">{hero.lede}</p>
        <CtaLink cta={hero.cta} />
        {hero.image !== undefined && (
          // Width and height are required by the schema, not optional: an image
          // without dimensions pushes layout while it loads, which is a defect
          // the audit engine charges money to find.
          <img
            src={hero.image.src}
            alt={hero.image.alt}
            width={hero.image.width}
            height={hero.image.height}
          />
        )}
      </section>

      {content.sections.map((section, i) => (
        <SectionView key={`${section.kind}-${i}`} section={section} />
      ))}

      <footer className="footer">
        <strong>{footer.brand}</strong>
        <span>{footer.tagline}</span>
      </footer>
    </main>
  );
}
