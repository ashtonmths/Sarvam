"use client";

import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { Suspense, useState } from "react";
import { DEMO_CREDENTIALS, signIn, signUp } from "../lib/session";
import { ThreadLines } from "./hero-graph";
import { LogoMark } from "./marks";

function AuthFormInner({ mode }: { mode: "signin" | "signup" }) {
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const router = useRouter();
  const searchParams = useSearchParams();
  const isSignup = mode === "signup";
  const next = searchParams.get("next") ?? "/app";

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
                  Already mapped your labyrinth? <Link href="/signin">Sign in</Link>
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
            onSubmit={async (event) => {
              event.preventDefault();
              setBusy(true);
              setError(null);

              const data = new FormData(event.currentTarget);
              const email = String(data.get("email") ?? "");
              const password = String(data.get("password") ?? "");

              const result = isSignup
                ? await signUp({
                    name: String(data.get("name") ?? ""),
                    email,
                    password,
                    company: String(data.get("org") ?? "") || undefined,
                  })
                : await signIn(email, password);

              if (result.ok) {
                router.push(next.startsWith("/") ? next : "/app");
                router.refresh();
              } else {
                setError(result.error);
                setBusy(false);
              }
            }}
          >
            {isSignup && (
              <div className="field">
                <label htmlFor="name">Name</label>
                <input
                  id="name"
                  name="name"
                  type="text"
                  placeholder="Priya Sharma"
                  autoComplete="name"
                  required
                />
              </div>
            )}
            <div className="field">
              <label htmlFor="email">Work email</label>
              <input
                id="email"
                name="email"
                type="email"
                placeholder="priya@company.com"
                autoComplete="email"
                required
              />
            </div>
            {isSignup && (
              <div className="field">
                <label htmlFor="org">Company</label>
                <input
                  id="org"
                  name="org"
                  type="text"
                  placeholder="Acme Operations"
                  autoComplete="organization"
                />
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
              />
            </div>

            <button
              type="submit"
              className="btn btn--ink"
              style={{ justifyContent: "center" }}
              disabled={busy}
              data-testid="auth-submit"
            >
              {isSignup ? "Create account" : "Sign in"}
            </button>

            {error && (
              <p className="auth__notice" role="alert">
                {error}
              </p>
            )}

            {isSignup && (
              <p className="auth__legal">
                Creating an account means you accept our <a href="/legal/terms">Terms</a>{" "}
                and <a href="/legal/privacy">Privacy policy</a>. Sadhak is free during
                beta, and both pages say plainly what has not been reviewed yet.
              </p>
            )}

            {!isSignup && (
              <p className="auth__notice" role="note">
                Seeded demo account (<code>pnpm seed</code>):{" "}
                <code>{DEMO_CREDENTIALS.email}</code> /{" "}
                <code>{DEMO_CREDENTIALS.password}</code>
              </p>
            )}
          </form>
        </div>
      </div>

      <div className="auth__art-side">
        <ThreadLines className="auth__art-thread" />
        <blockquote className="auth__art-quote">
          <p>
            &ldquo;The one person who knew why that field existed left in March.&rdquo;
          </p>
          <cite>Every ops team, eventually. Sadhak remembers the why.</cite>
        </blockquote>
      </div>
    </div>
  );
}

export function AuthForm({ mode }: { mode: "signin" | "signup" }) {
  // useSearchParams needs a Suspense boundary during static generation.
  return (
    <Suspense fallback={null}>
      <AuthFormInner mode={mode} />
    </Suspense>
  );
}
