"use client";

import Link from "next/link";
import { useState } from "react";
import { ThreadLines } from "./hero-graph";
import { LogoMark } from "./marks";

export function AuthForm({ mode }: { mode: "signin" | "signup" }) {
  const [submitted, setSubmitted] = useState(false);
  const isSignup = mode === "signup";

  return (
    <div className="auth">
      <div className="auth__form-side">
        <Link href="/" className="logo" aria-label="Sadhak home">
          <LogoMark />
          sadhak
        </Link>

        <div className="auth__form-wrap">
          <div>
            <span className="eyebrow eyebrow--thread">
              {isSignup ? "Early access" : "Welcome back"}
            </span>
            <h1 className="auth__title" style={{ marginTop: 12 }}>
              {isSignup ? "Create your account" : "Sign in to Sadhak"}
            </h1>
            <p className="auth__sub">
              {isSignup ? (
                <>
                  Already mapped your labyrinth?{" "}
                  <Link href="/signin">Sign in</Link>
                </>
              ) : (
                <>
                  New here? <Link href="/signup">Create an account</Link>
                </>
              )}
            </p>
          </div>

          <form
            className="auth__form"
            onSubmit={(event) => {
              event.preventDefault();
              setSubmitted(true);
            }}
          >
            {isSignup && (
              <div className="field">
                <label htmlFor="name">Name</label>
                <input id="name" name="name" type="text" placeholder="Priya Sharma" autoComplete="name" required />
              </div>
            )}
            <div className="field">
              <label htmlFor="email">Work email</label>
              <input id="email" name="email" type="email" placeholder="priya@company.com" autoComplete="email" required />
            </div>
            {isSignup && (
              <div className="field">
                <label htmlFor="org">Company</label>
                <input id="org" name="org" type="text" placeholder="Acme Operations" autoComplete="organization" />
              </div>
            )}
            <div className="field">
              <label htmlFor="password">Password</label>
              <input
                id="password"
                name="password"
                type="password"
                placeholder={isSignup ? "At least 12 characters" : "Your password"}
                autoComplete={isSignup ? "new-password" : "current-password"}
                required
                minLength={isSignup ? 12 : undefined}
              />
            </div>

            <button type="submit" className="btn btn--ink" style={{ justifyContent: "center" }}>
              {isSignup ? "Create account" : "Sign in"}
            </button>

            {submitted && (
              <p className="auth__notice" role="status">
                Nothing is wired behind this button yet. Accounts open when the
                API lands, and this form will start working without changing.
              </p>
            )}
          </form>
        </div>
      </div>

      <div className="auth__art-side">
        <ThreadLines className="auth__art-thread" />
        <blockquote className="auth__art-quote">
          <p>
            &ldquo;The one person who knew why that field existed left in
            March.&rdquo;
          </p>
          <cite>Every ops team, eventually. Sadhak remembers the why.</cite>
        </blockquote>
      </div>
    </div>
  );
}
