"use client";

import { useCallback, useEffect, useState } from "react";
import { ApiError, api, type GraphStats } from "./api";

/**
 * A minimal fetch-on-mount hook. TanStack Query is the Plan 12 answer once the
 * app has enough surfaces to justify a cache; until then this keeps the
 * dependency count honest and the behaviour obvious.
 */

export interface Query<T> {
  data: T | null;
  loading: boolean;
  error: string | null;
  reload: () => void;
}

export function useQuery<T>(path: string | null, deps: unknown[] = []): Query<T> {
  const [data, setData] = useState<T | null>(null);
  const [loading, setLoading] = useState(path !== null);
  const [error, setError] = useState<string | null>(null);
  const [nonce, setNonce] = useState(0);

  useEffect(() => {
    if (path === null) {
      setLoading(false);
      return;
    }
    let cancelled = false;
    setLoading(true);

    api
      .get<T>(path)
      .then((result) => {
        if (cancelled) return;
        setData(result);
        setError(null);
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        setError(err instanceof ApiError ? err.userMessage : "Could not reach the API");
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });

    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [path, nonce, ...deps]);

  const reload = useCallback(() => setNonce((n) => n + 1), []);
  return { data, loading, error, reload };
}

/** Whether this org has a crawled graph yet — what drives every empty state. */
export function useGraphStats(orgId: number | null): Query<GraphStats> {
  return useQuery<GraphStats>(orgId === null ? null : "/api/graph/stats", [orgId]);
}

export function useHasGraph(orgId: number | null): {
  hasGraph: boolean;
  loading: boolean;
} {
  const { data, loading } = useGraphStats(orgId);
  return { hasGraph: (data?.nodes.total ?? 0) > 0, loading };
}
