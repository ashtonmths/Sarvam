"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useState } from "react";
import { LogoMark } from "./marks";

const LINKS = [
  { href: "/product/blast-radius", label: "Blast radius" },
  { href: "/product/agents", label: "Agents" },
  { href: "/product/gate", label: "The gate" },
  { href: "/pricing", label: "Pricing" },
];

export function Nav() {
  const [open, setOpen] = useState(false);
  const [scrolled, setScrolled] = useState(false);
  const pathname = usePathname();

  useEffect(() => {
    const onScroll = () => setScrolled(window.scrollY > 8);
    onScroll();
    window.addEventListener("scroll", onScroll, { passive: true });
    return () => window.removeEventListener("scroll", onScroll);
  }, []);

  useEffect(() => {
    setOpen(false);
  }, [pathname]);

  return (
    <header className={`nav${scrolled ? " nav--scrolled" : ""}`}>
      <div className="container nav__inner">
        <Link href="/" className="logo" aria-label="Ariadne home">
          <LogoMark />
          ariadne
        </Link>

        <nav
          id="site-nav"
          className={`nav__links${open ? " nav__links--open" : ""}`}
          aria-label="Main"
        >
          {LINKS.map((link) => (
            <Link
              key={link.href}
              href={link.href}
              className="nav__link"
              aria-current={pathname === link.href ? "page" : undefined}
            >
              {link.label}
            </Link>
          ))}
          <Link href="/signin" className="btn btn--ink btn--small nav__cta-mobile">
            Sign in
          </Link>
        </nav>

        <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
          <Link href="/signin" className="btn btn--ink btn--small nav__cta">
            Sign in
          </Link>
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
