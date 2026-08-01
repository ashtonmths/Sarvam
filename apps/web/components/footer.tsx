import Link from "next/link";
import { LogoMark } from "./marks";

export function Footer() {
  return (
    <footer className="footer">
      <div className="footer__wrap">
        <div className="footer__panel">
          <div className="footer__inner">
            <div>
              <Link href="/" className="logo" aria-label="Sadhak home">
                <LogoMark />
                sadhak
              </Link>
              <p className="footer__tagline">
                Every company&apos;s operations are a labyrinth. Sadhak is the thread: it
                knows every passage, remembers why each wall was built, and stops you
                before you knock down a load bearing one.
              </p>
            </div>

            <div className="footer__cols">
              <div className="footer__col">
                <span className="footer__col-title">Product</span>
                <Link className="footer__link" href="/product/blast-radius">
                  Blast radius
                </Link>
                <Link className="footer__link" href="/product/agents">
                  Agents
                </Link>
                <Link className="footer__link" href="/product/gate">
                  The gate
                </Link>
              </div>
              <div className="footer__col">
                <span className="footer__col-title">Project</span>
                <a
                  className="footer__link"
                  href="https://github.com/ashtonmths/Sarvam"
                  target="_blank"
                  rel="noreferrer"
                >
                  GitHub
                </a>
                <a
                  className="footer__link"
                  href="https://github.com/ashtonmths/Sarvam/tree/main/docs"
                  target="_blank"
                  rel="noreferrer"
                >
                  Architecture docs
                </a>
              </div>
              <div className="footer__col">
                <span className="footer__col-title">Account</span>
                <Link className="footer__link" href="/signin">
                  Sign in
                </Link>
                <Link className="footer__link" href="/signup">
                  Create account
                </Link>
              </div>
              <div className="footer__col">
                <span className="footer__col-title">Legal</span>
                <Link className="footer__link" href="/legal/privacy">
                  Privacy
                </Link>
                <Link className="footer__link" href="/legal/terms">
                  Terms
                </Link>
                <Link className="footer__link" href="/legal/subprocessors">
                  Subprocessors
                </Link>
                <Link className="footer__link" href="/legal/dpa">
                  DPA
                </Link>
              </div>
            </div>
          </div>

          <div className="footer__thread" aria-hidden="true">
            <span className="footer__thread-chip">
              <LogoMark size={20} />
            </span>
          </div>

          <div className="footer__legal">
            <span>Sadhak</span>
            <span>Change intelligence for business operations</span>
          </div>
        </div>
      </div>
    </footer>
  );
}
