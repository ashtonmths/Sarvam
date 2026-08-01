import Link from "next/link";
import type { ReactNode } from "react";
import { Footer } from "./footer";
import { Nav } from "./nav";

interface FeaturePageProps {
  eyebrow: string;
  title: ReactNode;
  lede: string;
  visual: ReactNode;
  children: ReactNode;
  prev?: { href: string; title: string };
  next?: { href: string; title: string };
}

export function FeaturePage({ eyebrow, title, lede, visual, children, prev, next }: FeaturePageProps) {
  return (
    <>
      <Nav />
      <main>
        <div className="container">
          <section className="fpage-hero">
            <div className="fpage-hero__inner">
              <span className="eyebrow eyebrow--thread">{eyebrow}</span>
              <h1 className="fpage-hero__title">{title}</h1>
              <p className="fpage-hero__lede">{lede}</p>
            </div>
            <div className="fpage-visual">{visual}</div>
          </section>

          {children}

          <nav className="fpager" aria-label="More product pages">
            {prev ? (
              <Link href={prev.href} className="fpager__card">
                <span className="fpager__dir">← Previous</span>
                <span className="fpager__title">{prev.title}</span>
              </Link>
            ) : (
              <span />
            )}
            {next ? (
              <Link href={next.href} className="fpager__card fpager__card--next">
                <span className="fpager__dir">Next →</span>
                <span className="fpager__title">{next.title}</span>
              </Link>
            ) : (
              <span />
            )}
          </nav>
        </div>

        <section className="cta">
          <div className="container">
            <div className="cta__panel">
              <h2>Put a thread through your labyrinth</h2>
              <p>
                Connect three systems and watch the map draw itself. Early
                access is open now.
              </p>
              <Link href="/signup" className="btn btn--paper">
                Get early access <span className="btn__arrow">→</span>
              </Link>
            </div>
          </div>
        </section>
      </main>
      <Footer />
    </>
  );
}

export function FeatureRow({
  eyebrow,
  title,
  copy,
  visual,
  flip = false,
}: {
  eyebrow: string;
  title: string;
  copy: ReactNode;
  visual: ReactNode;
  flip?: boolean;
}) {
  const copyBlock = (
    <div className="split__copy">
      <span className="eyebrow">{eyebrow}</span>
      <h2>{title}</h2>
      {copy}
    </div>
  );
  return (
    <section className="frow">
      <div className={flip ? "split split--flip" : "split"}>
        {flip ? (
          <>
            {visual}
            {copyBlock}
          </>
        ) : (
          <>
            {copyBlock}
            {visual}
          </>
        )}
      </div>
    </section>
  );
}
