"use client";

import { useSearchParams } from "next/navigation";
import { Suspense } from "react";
import { LiveGraph } from "../../../components/app/live-graph";
import { EmptyState, PageHead } from "../../../components/app/ui";
import { useGraphStats } from "../../../lib/queries";
import { useSession } from "../../../lib/session";

function GraphContent() {
  const { org } = useSession();
  const { data: stats, loading } = useGraphStats(org?.id ?? null);
  // Seeded by the topbar search, which routes here as /app/graph?q=term.
  const initialQuery = useSearchParams().get("q") ?? "";

  return (
    <>
      <PageHead
        title="Graph"
        sub="The living map: every table, view, workflow and field Sadhak has crawled from your own systems, read-only."
      />
      {loading ? (
        <div className="panel" style={{ height: 320, opacity: 0.4 }} />
      ) : (stats?.nodes.total ?? 0) > 0 ? (
        <LiveGraph initialQuery={initialQuery} />
      ) : (
        <EmptyState
          title="No graph yet"
          body="Connect a system and Sadhak will crawl it read-only — the map assembles in seconds."
          action={{ href: "/app/settings/connectors", label: "Add a connector →" }}
        />
      )}
    </>
  );
}

export default function GraphPage() {
  return (
    <Suspense fallback={null}>
      <GraphContent />
    </Suspense>
  );
}
