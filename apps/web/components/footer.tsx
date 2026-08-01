import Link from "next/link";
import { LogoMark } from "./marks";

export function Footer() {
  return (
    <footer className="footer">
      <div className="container">
        <div className="footer__inner">
          <div>
            <Link href="/" className="logo" aria-label="Sadhak home">
              <LogoMark />
              sadhak
            </Link>
            <p className="footer__tagline">
              Every company&apos;s operations are a labyrinth. Sadhak is the
              thread: it knows every passage, remembers why each wall was built,
              and stops you before you knock down a load bearing one.
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
              <Link className="footer__link" href="/pricing">
                Pricing
              </Link>
            </div>
            <div className="footer__col">
              <span className="footer__col-title">Project</span>
              <a
                className="footer__link"
                href="https://github.com/Finite-Loop-Club-NMAMIT/ariadne"
                target="_blank"
                rel="noreferrer"
              >
                GitHub
              </a>
              <a
                className="footer__link"
                href="https://github.com/Finite-Loop-Club-NMAMIT/ariadne/tree/main/docs"
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
          </div>
        </div>

        <div className="footer__legal">
          <span>Sadhak, built by Finite Loop Club</span>
          <span>Change intelligence for business operations</span>
        </div>
      </div>
    </footer>
  );
}
