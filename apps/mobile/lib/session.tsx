import * as SecureStore from "expo-secure-store";
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
} from "react";
import { Platform } from "react-native";
import { ApiError, api, signIn as apiSignIn, setSessionToken } from "./api";

/**
 * The session lives in the device keychain, not in memory, so closing the app
 * does not sign you out. SecureStore has no web backend, so the web build
 * (which is what we use to smoke-test) falls back to localStorage.
 */

const KEY = "sadhak.session";

const store = {
  async get(): Promise<string | null> {
    if (Platform.OS === "web") {
      try {
        return globalThis.localStorage?.getItem(KEY) ?? null;
      } catch {
        return null;
      }
    }
    return SecureStore.getItemAsync(KEY);
  },
  async set(value: string) {
    if (Platform.OS === "web") {
      try {
        globalThis.localStorage?.setItem(KEY, value);
      } catch {
        /* private mode */
      }
      return;
    }
    await SecureStore.setItemAsync(KEY, value);
  },
  async clear() {
    if (Platform.OS === "web") {
      try {
        globalThis.localStorage?.removeItem(KEY);
      } catch {
        /* private mode */
      }
      return;
    }
    await SecureStore.deleteItemAsync(KEY);
  },
};

/** Mirrors `GET /api/auth/me` — memberships key their id as `orgId`, not `id`. */
export interface Me {
  user: { id: number; email: string; name: string };
  orgs: { orgId: number; name: string; role: string }[];
  activeOrgId: number | null;
  role: string | null;
}

interface SessionValue {
  ready: boolean;
  user: Me["user"] | null;
  org: Me["orgs"][number] | null;
  signIn: (email: string, password: string) => Promise<void>;
  signOut: () => Promise<void>;
}

const Ctx = createContext<SessionValue | null>(null);

export function SessionProvider({ children }: { children: React.ReactNode }) {
  const [ready, setReady] = useState(false);
  const [me, setMe] = useState<Me | null>(null);

  const load = useCallback(async () => {
    const token = await store.get();
    if (!token) {
      setReady(true);
      return;
    }
    setSessionToken(token);
    try {
      setMe(await api.get<Me>("/api/auth/me"));
    } catch (err) {
      // Only a rejected credential clears the keychain. A network blip must not
      // sign someone out on a train.
      if (err instanceof ApiError && err.isAuth) {
        await store.clear();
        setSessionToken(null);
      }
    } finally {
      setReady(true);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const signIn = useCallback(async (email: string, password: string) => {
    const result = await apiSignIn(email, password);
    setSessionToken(result.token);
    await store.set(result.token);
    setMe(await api.get<Me>("/api/auth/me"));
  }, []);

  const signOut = useCallback(async () => {
    try {
      await api.post("/api/auth/signout");
    } catch {
      /* the local session goes regardless of what the server says */
    }
    await store.clear();
    setSessionToken(null);
    setMe(null);
  }, []);

  const value = useMemo<SessionValue>(
    () => ({
      ready,
      user: me?.user ?? null,
      org: me
        ? (me.orgs.find((o) => o.orgId === me.activeOrgId) ?? me.orgs[0] ?? null)
        : null,
      signIn,
      signOut,
    }),
    [ready, me, signIn, signOut],
  );

  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useSession(): SessionValue {
  const v = useContext(Ctx);
  if (!v) throw new Error("useSession must be used inside SessionProvider");
  return v;
}
