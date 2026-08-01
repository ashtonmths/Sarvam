"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { Fragment, useEffect, useState } from "react";
import { hasSessionCookie } from "../lib/session";
import { LogoMark } from "./marks";

// The three product pages are a guided walkthrough with prev/next pagers,
// so the nav draws them as stops on one dashed thread. Pricing sits apart.
const TRAIL = [
  { href: "/product/blast-radius", label: "Blast radius" },
  { href: "/product/agents", label: "Agents" },
  { href: "/product/gate", label: "The gate" },
];

export function Nav() {
  const [open, setOpen] = useState(false);
  const [scrolled, setScrolled] = useState(false);
  const [signedIn, setSignedIn] = useState(false);
  const pathname = usePathname();

  // Signing in or out happens on another page, so the cookie is re-read on
  // every navigation.
  // biome-ignore lint/correctness/useExhaustiveDependencies: pathname is the trigger, not an input
  useEffect(() => {
    setSignedIn(hasSessionCookie());
  }, [pathname]);

  useEffect(() => {
    const onScroll = () => setScrolled(window.scrollY > 8);
    onScroll();
    window.addEventListener("scroll", onScroll, { passive: true });
    return () => window.removeEventListener("scroll", onScroll);
  }, []);

  // biome-ignore lint/correctness/useExhaustiveDependencies: navigating is what closes the drawer
  useEffect(() => {
    setOpen(false);
  }, [pathname]);

  return (
    <header className={`nav${scrolled ? " nav--scrolled" : ""}`}>
      <div className="container nav__inner">
        <Link href="/" className="logo" aria-label="Sadhak home">
          <LogoMark />
          sadhak
        </Link>

        <nav
          id="site-nav"
          className={`nav__links${open ? " nav__links--open" : ""}`}
          aria-label="Main"
        >
          <span className="nav__trail">
            {TRAIL.map((link, i) => (
              <Fragment key={link.href}>
                {i > 0 && <i className="nav__dash" aria-hidden="true" />}
                <Link
                  href={link.href}
                  className="nav__link"
                  aria-current={pathname === link.href ? "page" : undefined}
                >
                  {link.label}
                </Link>
              </Fragment>
            ))}
          </span>
          <Link
            href="/docs"
            className="nav__link"
            aria-current={pathname.startsWith("/docs") ? "page" : undefined}
          >
            Docs
          </Link>
          <div className="nav__cta-mobile">
            {signedIn ? (
              <Link href="/app" className="btn btn--ink btn--small">
                Open app <span className="btn__arrow">-&gt;</span>
              </Link>
            ) : (
              <>
                <Link href="/signin" className="btn btn--ghost btn--small">
                  Sign in
                </Link>
                <Link href="/signup" className="btn btn--ink btn--small">
                  Get started
                </Link>
              </>
            )}
          </div>
        </nav>

        <div className="nav__actions">
          {signedIn ? (
            <Link href="/app" className="btn btn--ink btn--small nav__cta">
              Open app <span className="btn__arrow">-&gt;</span>
            </Link>
          ) : (
            <>
              <Link href="/signin" className="nav__signin nav__cta">
                Sign in
              </Link>
              <Link href="/signup" className="btn btn--ink btn--small nav__cta">
                Get started
              </Link>
            </>
          )}
          <button
            type="button"
            className="nav__toggle"
            aria-expanded={open}
            aria-controls="site-nav"
            onClick={() => setOpen((v) => !v)}
          >
            {open ? "Close" : "Menu"}
          </button>
        </div>
      </div>
    </header>
  );
}
