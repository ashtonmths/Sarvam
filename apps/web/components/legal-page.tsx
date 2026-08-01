import type { ReactNode } from "react";
import { Footer } from "./footer";
import { Nav } from "./nav";

/**
 * The shared frame for the four legal pages.
 *
 * These are read by someone deciding whether to hand us credentials to their
 * revenue stack, usually right before a security questionnaire. So they get the
 * same care as the product pages rather than a wall of unstyled text: a fixed
 * measure, a table of contents that tracks where you are, and — the part that
 * matters most — a review status stated at the top instead of buried.
 */

export interface LegalSection {
  id: string;
  title: string;
  body: ReactNode;
}

interface LegalPageProps {
  title: string;
  summary: string;
  effective: string;
  version: string;
  /** Shown above the contents. Use for the counsel-review status. */
  notice?: ReactNode;
  sections: LegalSection[];
  /** Rendered after the last section, e.g. a download link. */
  footnote?: ReactNode;
}

export function LegalPage({
  title,
  summary,
  effective,
  version,
  notice,
  sections,
  footnote,
}: LegalPageProps) {
  return (
    <>
      <Nav />

      <header className="legal__hero">
        <div className="container">
          <span className="eyebrow">Legal</span>
          <h1 className="legal__title">{title}</h1>
          <p className="legal__summary">{summary}</p>
          <div className="legal__meta">
            <span className="legal__chip">
              Effective <strong>{effective}</strong>
            </span>
            <span className="legal__chip">
              Version <strong>{version}</strong>
            </span>
            <a className="legal__chip legal__chip--link" href="/legal/changelog">
              Change history
            </a>
          </div>
        </div>
      </header>

      <div className="container legal__grid">
        <aside className="legal__toc" aria-label="On this page">
          <span className="legal__toc-title">On this page</span>
          <nav>
            {sections.map((section) => (
              <a key={section.id} className="legal__toc-link" href={`#${section.id}`}>
                {section.title}
              </a>
            ))}
          </nav>
        </aside>

        <main className="legal__body">
          {notice ? <div className="legal__notice">{notice}</div> : null}

          {sections.map((section) => (
            <section key={section.id} id={section.id} className="legal__section">
              {/* The anchor lives on the heading so a questionnaire can cite a
                  clause by link rather than by quoting it into a spreadsheet.
                  It is labelled rather than aria-hidden: it takes focus, so
                  hiding it would hand a keyboard user a stop with nothing
                  announced at it. */}
              <h2 className="legal__h2">
                <a
                  className="legal__anchor"
                  href={`#${section.id}`}
                  aria-label={`Link to “${section.title}”`}
                >
                  #
                </a>
                {section.title}
              </h2>
              {section.body}
            </section>
          ))}

          {footnote ? <div className="legal__footnote">{footnote}</div> : null}
        </main>
      </div>

      <Footer />
    </>
  );
}
