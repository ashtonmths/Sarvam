"use client";

import { useEffect, useState } from "react";
import { ApiError, api, type MeResponse } from "./api";

/**
 * Real session, backed by the API's httpOnly cookie. The hook signatures are
 * the same ones the mock exposed, so every screen built against it kept
 * working when the backend landed.
 */

export const SESSION_COOKIE = "sadhak_session";

/** Seeded by `pnpm seed`, shown on the sign-in form for the demo. */
export const DEMO_CREDENTIALS = {
  email: "demo@sadhak.online",
  password: "sadhak-demo-2026",
};

export interface SessionUser {
  id: number;
  name: string;
  email: string;
  role: "owner" | "admin" | "member" | "viewer";
}

export interface Org {
  id: number;
  name: string;
  slug: string;
  role: "owner" | "admin" | "member" | "viewer";
}

export function hasSessionCookie(): boolean {
  if (typeof document === "undefined") return false;
  return document.cookie.split("; ").some((c) => c.startsWith(`${SESSION_COOKIE}=`));
}

export async function signIn(
  email: string,
  password: string,
): Promise<{ ok: true } | { ok: false; error: string }> {
  try {
    await api.post("/api/auth/signin", { email, password });
    return { ok: true };
  } catch (error) {
    return {
      ok: false,
      error: error instanceof ApiError ? error.userMessage : "Could not reach the API",
    };
  }
}

export async function signUp(input: {
  name: string;
  email: string;
  password: string;
  company?: string;
}): Promise<{ ok: true } | { ok: false; error: string }> {
  try {
    await api.post("/api/auth/signup", input);
    return { ok: true };
  } catch (error) {
    return {
      ok: false,
      error: error instanceof ApiError ? error.userMessage : "Could not reach the API",
    };
  }
}

export async function signOut(): Promise<void> {
  await api.post("/api/auth/signout").catch(() => undefined);
}

export async function switchOrg(orgId: number): Promise<void> {
  await api.post("/api/auth/orgs/switch", { orgId });
  window.dispatchEvent(new Event("sadhak:org"));
}

export interface SessionState {
  ready: boolean;
  user: SessionUser | null;
  org: Org | null;
  orgs: Org[];
  capabilities: string[];
  refresh: () => void;
}

export function useSession(): SessionState {
  const [state, setState] = useState<Omit<SessionState, "refresh">>({
    ready: false,
    user: null,
    org: null,
    orgs: [],
    capabilities: [],
  });
  const [nonce, setNonce] = useState(0);

  // `nonce` is never read in the effect: bumping it is how refresh() re-fetches.
  // biome-ignore lint/correctness/useExhaustiveDependencies: nonce is the re-run trigger
  useEffect(() => {
    let cancelled = false;

    const load = async () => {
      try {
        const me = await api.get<MeResponse>("/api/auth/me");
        if (cancelled) return;

        const orgs: Org[] = me.orgs.map((o) => ({
          id: o.orgId,
          name: o.name,
          slug: o.slug,
          role: o.role,
        }));
        const active = orgs.find((o) => o.id === me.activeOrgId) ?? orgs[0] ?? null;

        setState({
          ready: true,
          user: {
            id: me.user.id,
            name: me.user.name,
            email: me.user.email,
            role: me.role ?? "viewer",
          },
          org: active,
          orgs,
          capabilities: me.capabilities,
        });
      } catch {
        if (!cancelled) {
          setState({ ready: true, user: null, org: null, orgs: [], capabilities: [] });
        }
      }
    };

    void load();
    const onOrgChange = () => void load();
    window.addEventListener("sadhak:org", onOrgChange);
    return () => {
      cancelled = true;
      window.removeEventListener("sadhak:org", onOrgChange);
    };
  }, [nonce]);

  return { ...state, refresh: () => setNonce((n) => n + 1) };
}

export function can(capabilities: string[], capability: string): boolean {
  return capabilities.includes(capability);
}
