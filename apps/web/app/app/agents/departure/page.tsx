"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { Select } from "../../../../components/app/select";
import { EmptyState, PageHead } from "../../../../components/app/ui";
import { ApiError, api, type GraphNode, type Page } from "../../../../lib/api";
import { useQuery } from "../../../../lib/queries";

/**
 * The exit interview: fan Historian out over the edges only a departing person
 * ever explained.
 *
 * Quota is a designed state here, not an error. At the free tier a 12-edge run
 * costs roughly 60 model requests, so the API refuses a run it cannot finish
 * and returns how many edges *would* fit — half a fan-out is strictly worse
 * than none, because it spends the day's quota and hands the reviewer an
 * arbitrary half with no signal about which half is missing.
 */

interface QuotaRefusal {
  detail: string;
  remaining: number;
  estimated: number;
  edgesThatWouldFit: number;
}

export default function DeparturePage() {
  const router = useRouter();
  const people = useQuery<Page<GraphNode>>("/api/graph/nodes?limit=200&kind=person");
  const quota = useQuery<{ remaining: number; note: string }>("/api/historian/quota");

  const [subject, setSubject] = useState<string>("");
  const [starting, setStarting] = useState(false);
  const [refusal, setRefusal] = useState<QuotaRefusal | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const items = people.data?.items ?? [];
  const selected = items.find((p) => String(p.id) === subject) ?? items[0] ?? null;

  async function start() {
    if (!selected) return;
    setStarting(true);
    setRefusal(null);
    setNotice(null);

    try {
      const res = await api.post<{ runId?: string; edges: number; message?: string }>(
        "/api/historian/runs",
        { kind: "exit_interview", subjectNodeId: selected.id },
      );
      if (res.runId) {
        router.push(`/app/agents/${res.runId}`);
        return;
      }
      // Nothing sole-sourced to them is the goal state, not a failure.
      setNotice(res.message ?? "Nothing to investigate — no sole-source edges.");
    } catch (err) {
      if (err instanceof ApiError && err.status === 429) {
        const problem = err.problem as unknown as QuotaRefusal;
        setRefusal({
          detail: err.userMessage,
          remaining: problem.remaining ?? 0,
          estimated: problem.estimated ?? 0,
          edgesThatWouldFit: problem.edgesThatWouldFit ?? 0,
        });
      } else {
        setNotice(err instanceof ApiError ? err.userMessage : "Could not start the run");
      }
    } finally {
      setStarting(false);
    }
  }

  return (
    <>
      <PageHead
        title="Exit interview"
        sub="When someone leaves, the edges only they ever explained become unexplained. Investigate them while the written trail still exists."
      >
        <Link href="/app/agents" className="btn btn--ghost btn--small">
          ← All runs
        </Link>
      </PageHead>

      {notice && (
        <div className="banner banner--info" role="status">
          {notice}
        </div>
      )}

      {refusal && (
        <div
          className="banner banner--warn"
          role="status"
          data-testid="departure-quota-offer"
        >
          {/* An offer, not a dead end. */}
          {refusal.detail} Nothing was started, so nothing needs cleaning up.
        </div>
      )}

      {people.loading ? (
        <div className="panel" style={{ height: 160, opacity: 0.4 }} />
      ) : items.length === 0 ? (
        <EmptyState
          title="No people on the map yet"
          body="Sadhak learns who explains what from confirmed rationale and OWNED_BY edges. Once people appear in the graph, their sole-source edges become visible here."
          action={{ href: "/app/queue", label: "Review pending rationale →" }}
        />
      ) : (
        <div className="panel">
          <h2 className="panel__title">Who is leaving?</h2>
          <p className="panel__caption">
            Sadhak resolves the edges only they explain, then runs one investigation per
            edge. Drafts land in the queue for your review — they never count as coverage
            on their own.
          </p>

          <div
            style={{ display: "flex", gap: 14, flexWrap: "wrap", alignItems: "flex-end" }}
          >
            <Select
              value={String(selected?.id ?? "")}
              onChange={setSubject}
              label="Departing person"
              testid="departure-person-picker"
              options={items.map((p) => ({ value: String(p.id), label: p.name }))}
            />
            <button
              type="button"
              className="btn btn--ink"
              disabled={starting || !selected}
              onClick={() => void start()}
              data-testid="departure-start"
            >
              {starting ? "Starting…" : "Start investigation"}
            </button>
          </div>

          <p className="panel__foot">
            {quota.data?.remaining ?? "—"} model requests remain today, shared across
            every org. A loop costs about five.
          </p>
        </div>
      )}
    </>
  );
}
