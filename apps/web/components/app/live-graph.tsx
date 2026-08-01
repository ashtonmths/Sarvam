"use client";

import { useMemo, useState } from "react";
import { ApiError, api, type GraphEdge, type GraphNode, type Page } from "../../lib/api";
import { useQuery } from "../../lib/queries";
import { ProvenanceTag } from "./ui";

/**
 * The real crawled graph. Positions are laid out from the graph's own
 * structure rather than stored — a force simulation in a worker is the Plan 12
 * upgrade, and this deterministic layout is what the demo needs today.
 */

const CONNECTOR_COLOR: Record<string, string> = {
  postgres: "#2f7a4d",
  n8n: "#c05a2e",
  airtable: "#3a7bd0",
  slack: "#8352c5",
  github: "#57606a",
  http: "#8a8f99",
};

const KIND_RADIUS: Record<string, number> = {
  table: 15,
  report: 15,
  workflow: 16,
  service: 15,
  field: 9,
  step: 10,
  credential: 11,
  endpoint: 12,
  person: 12,
};

const DASH: Record<string, string | undefined> = {
  static_parse: undefined,
  runtime_observed: "6 4",
  llm_inferred: "2 4",
};

const CRIT_STOPS = [1.0, 0.7, 0.4, 0.1];

export function LiveGraph() {
  const [view, setView] = useState<"map" | "list">("map");
  const [selected, setSelected] = useState<number | null>(null);
  const [q, setQ] = useState("");
  const [kind, setKind] = useState("all");
  const [critReason, setCritReason] = useState("");
  const [pendingCrit, setPendingCrit] = useState<number | null>(null);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);

  const nodesQuery = useQuery<Page<GraphNode>>("/api/graph/nodes?limit=200");
  const edgesQuery = useQuery<Page<GraphEdge>>("/api/graph/edges?limit=200");

  const nodes = useMemo(() => nodesQuery.data?.items ?? [], [nodesQuery.data]);
  const edges = useMemo(() => edgesQuery.data?.items ?? [], [edgesQuery.data]);
  const nodeById = useMemo(() => new Map(nodes.map((n) => [n.id, n])), [nodes]);

  /**
   * Layered layout: dependencies sink, dependents rise. `src` depends on `dst`,
   * so a node's depth is one below the deepest thing it depends on.
   */
  const positions = useMemo(() => {
    const depth = new Map<number, number>();
    for (const node of nodes) depth.set(node.id, 0);

    for (let pass = 0; pass < 6; pass += 1) {
      for (const edge of edges) {
        const src = depth.get(edge.srcId);
        const dst = depth.get(edge.dstId);
        if (src === undefined || dst === undefined) continue;
        if (src <= dst) depth.set(edge.srcId, dst + 1);
      }
    }

    const byLayer = new Map<number, GraphNode[]>();
    for (const node of nodes) {
      const layer = depth.get(node.id) ?? 0;
      const bucket = byLayer.get(layer);
      if (bucket) bucket.push(node);
      else byLayer.set(layer, [node]);
    }

    const layers = [...byLayer.keys()].sort((a, b) => a - b);
    const out = new Map<number, { x: number; y: number }>();
    const height = 640;

    layers.forEach((layer, layerIndex) => {
      const members = (byLayer.get(layer) ?? [])
        .slice()
        .sort((a, b) => a.name.localeCompare(b.name));
      const x = 90 + layerIndex * (940 / Math.max(1, layers.length - 1 || 1));
      members.forEach((node, i) => {
        const y = ((i + 1) / (members.length + 1)) * height + 30;
        out.set(node.id, { x: layers.length === 1 ? 520 : x, y });
      });
    });

    return out;
  }, [nodes, edges]);

  const visible = useMemo(() => {
    const needle = q.trim().toLowerCase();
    return nodes.filter((n) => {
      if (kind !== "all" && n.kind !== kind) return false;
      if (
        needle &&
        !n.name.toLowerCase().includes(needle) &&
        !n.externalId.toLowerCase().includes(needle)
      )
        return false;
      return true;
    });
  }, [nodes, q, kind]);

  const visibleIds = useMemo(() => new Set(visible.map((n) => n.id)), [visible]);
  const selNode = selected !== null ? (nodeById.get(selected) ?? null) : null;

  /** Everything that would break, walking dst → src from the selected node. */
  const impacted = useMemo(() => {
    if (selected === null) return new Map<number, number>();
    const hops = new Map<number, number>();
    let frontier = [selected];
    for (let hop = 1; hop <= 6 && frontier.length > 0; hop += 1) {
      const next: number[] = [];
      for (const id of frontier) {
        for (const edge of edges) {
          if (edge.dstId !== id || hops.has(edge.srcId) || edge.srcId === selected)
            continue;
          hops.set(edge.srcId, hop);
          next.push(edge.srcId);
        }
      }
      frontier = next;
    }
    return hops;
  }, [selected, edges]);

  if (nodesQuery.loading || edgesQuery.loading) {
    return <div className="panel" style={{ height: 320, opacity: 0.4 }} />;
  }

  if (nodesQuery.error) {
    return (
      <div className="empty">
        <strong>Could not load the graph</strong>
        <p>{nodesQuery.error}</p>
      </div>
    );
  }

  const kinds = [...new Set(nodes.map((n) => n.kind))].sort();

  async function saveCriticality(nodeId: number, value: number) {
    setSaving(true);
    setSaveError(null);
    try {
      await api.patch(`/api/nodes/${nodeId}/criticality`, { value, reason: critReason });
      setPendingCrit(null);
      setCritReason("");
      nodesQuery.reload();
    } catch (error) {
      setSaveError(error instanceof ApiError ? error.userMessage : "Save failed");
    } finally {
      setSaving(false);
    }
  }

  return (
    <div>
      <div className="filters">
        <input
          type="search"
          placeholder="Search nodes or external ids…"
          value={q}
          onChange={(e) => setQ(e.target.value)}
          aria-label="Search nodes"
          data-testid="graph-search"
        />
        <select
          value={kind}
          onChange={(e) => setKind(e.target.value)}
          aria-label="Filter by kind"
        >
          <option value="all">All kinds</option>
          {kinds.map((k) => (
            <option key={k} value={k}>
              {k}
            </option>
          ))}
        </select>
        <span className="dim" style={{ fontSize: 12.5 }}>
          {visible.length} of {nodes.length} nodes
        </span>
        <div className="tabs" style={{ margin: 0, marginLeft: "auto" }} role="tablist">
          <button
            type="button"
            role="tab"
            aria-selected={view === "map"}
            onClick={() => setView("map")}
            data-testid="graph-view-map"
          >
            Map
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={view === "list"}
            onClick={() => setView("list")}
            data-testid="graph-view-list"
          >
            List
          </button>
        </div>
      </div>

      {view === "list" ? (
        <div className="panel" style={{ padding: 0, overflow: "hidden" }}>
          <table className="dtable dtable--click">
            <thead>
              <tr>
                <th>Node</th>
                <th>Kind</th>
                <th>Connector</th>
                <th>Criticality</th>
                <th>State</th>
              </tr>
            </thead>
            <tbody>
              {visible.map((n) => (
                <tr
                  key={n.id}
                  data-selected={selected === n.id}
                  onClick={() => setSelected(n.id)}
                  onKeyDown={(e) => e.key === "Enter" && setSelected(n.id)}
                  tabIndex={0}
                  data-testid={`graph-row-${n.id}`}
                >
                  <td>
                    <strong>{n.name}</strong>
                    <div className="mono dim">{n.externalId}</div>
                  </td>
                  <td>{n.kind}</td>
                  <td>
                    <span className="tag" style={{ color: CONNECTOR_COLOR[n.connector] }}>
                      {n.connector}
                    </span>
                  </td>
                  <td className="mono">
                    {n.criticality.toFixed(1)}
                    {n.criticalitySource === "human" && (
                      <span className="tag tag--green" style={{ marginLeft: 6 }}>
                        human
                      </span>
                    )}
                  </td>
                  <td>
                    {n.state === "stale" ? (
                      <span className="tag tag--amber">stale</span>
                    ) : (
                      <span className="dim">active</span>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <div className="graph-wrap">
          <div className="graph-canvas">
            <svg
              viewBox="0 0 1120 700"
              aria-label="Dependency graph. Use the list view for keyboard navigation."
            >
              {edges
                .filter((e) => visibleIds.has(e.srcId) && visibleIds.has(e.dstId))
                .map((e) => {
                  const s = positions.get(e.srcId);
                  const t = positions.get(e.dstId);
                  if (!s || !t) return null;
                  const inRipple =
                    selected !== null &&
                    (e.dstId === selected || impacted.has(e.dstId)) &&
                    impacted.has(e.srcId);
                  return (
                    <line
                      key={e.id}
                      x1={s.x}
                      y1={s.y}
                      x2={t.x}
                      y2={t.y}
                      stroke={inRipple ? "var(--block)" : "var(--ink-faint)"}
                      strokeWidth={inRipple ? 2 : 1.2}
                      strokeOpacity={inRipple ? 0.8 : e.confidence * 0.45}
                      strokeDasharray={DASH[e.provenance]}
                    />
                  );
                })}

              {visible.map((n) => {
                const pos = positions.get(n.id);
                if (!pos) return null;
                const r = KIND_RADIUS[n.kind] ?? 11;
                const hop = impacted.get(n.id);
                const color = CONNECTOR_COLOR[n.connector] ?? "#8a8f99";
                return (
                  // The map is the primary way into a node's dependents, so it
                  // is reachable without a pointer: tab to a node, Enter or
                  // Space to select it. SVG has no button element to reach for.
                  // biome-ignore lint/a11y/useSemanticElements: <button> is not valid inside <svg>
                  <g
                    key={n.id}
                    className={`graph-node${selected === n.id ? " graph-node--selected" : ""}`}
                    role="button"
                    tabIndex={0}
                    aria-pressed={selected === n.id}
                    aria-label={`${n.name} — ${n.kind} on ${n.connector}`}
                    onClick={() => setSelected(n.id)}
                    onKeyDown={(e) => {
                      if (e.key === "Enter" || e.key === " ") {
                        e.preventDefault();
                        setSelected(n.id);
                      }
                    }}
                  >
                    {/* The locked visual: opacity is the impact score. */}
                    {hop !== undefined && (
                      <circle
                        className="graph-ripple"
                        cx={pos.x}
                        cy={pos.y}
                        r={r + 9}
                        fill="var(--block)"
                        style={{
                          opacity: n.criticality * 0.6 ** (hop - 1),
                          animationDelay: `${hop * 120}ms`,
                        }}
                      />
                    )}
                    <circle
                      cx={pos.x}
                      cy={pos.y}
                      r={r}
                      fill="var(--card)"
                      stroke={color}
                      strokeWidth={2}
                      strokeDasharray={n.state === "stale" ? "3 3" : undefined}
                      opacity={
                        selected !== null && hop === undefined && selected !== n.id
                          ? 0.3
                          : 1
                      }
                    />
                    <text x={pos.x} y={pos.y + r + 12} textAnchor="middle">
                      {n.name.length > 22 ? `${n.name.slice(0, 21)}…` : n.name}
                    </text>
                  </g>
                );
              })}
            </svg>

            <div className="graph-legend" aria-hidden="true">
              <span>
                <i /> static
              </span>
              <span>
                <i className="dashed" /> runtime
              </span>
              <span>
                <i className="dotted" /> llm-inferred
              </span>
              <span>ripple opacity = impact</span>
            </div>
          </div>

          <aside className="node-panel panel" aria-live="polite">
            {!selNode ? (
              <p style={{ fontSize: 14, color: "var(--ink-soft)" }}>
                Select a node to see what depends on it. The ripple&rsquo;s opacity is the
                impact score — darker is worse. Dependencies sink left, dependents rise
                right.
              </p>
            ) : (
              <>
                <div className="node-panel__kind">
                  <span
                    className="tag"
                    style={{ color: CONNECTOR_COLOR[selNode.connector] }}
                  >
                    {selNode.connector}
                  </span>
                  <span className="tag">{selNode.kind}</span>
                  {selNode.state === "stale" && (
                    <span className="tag tag--amber">stale</span>
                  )}
                </div>
                <h2>{selNode.name}</h2>
                <p
                  className="mono dim"
                  style={{ fontSize: 11.5, overflowWrap: "anywhere" }}
                >
                  {selNode.externalId}
                </p>

                {impacted.size > 0 && (
                  <div className="node-panel__section">
                    <h3>Blast radius · {impacted.size} nodes</h3>
                    {[...impacted.entries()]
                      .sort((a, b) => a[1] - b[1])
                      .slice(0, 8)
                      .map(([id, hop]) => {
                        const node = nodeById.get(id);
                        if (!node) return null;
                        return (
                          <div key={id} className="evidence__row">
                            <span style={{ flex: 1 }}>{node.name}</span>
                            <span className="mono dim">{hop}h</span>
                            <span className="evidence__impact">
                              {(node.criticality * 0.6 ** (hop - 1)).toFixed(2)}
                            </span>
                          </div>
                        );
                      })}
                  </div>
                )}

                <div className="node-panel__section">
                  <h3>Criticality</h3>
                  <fieldset className="crit-stops" aria-label="Criticality stops">
                    {CRIT_STOPS.map((c) => (
                      <button
                        key={c}
                        type="button"
                        aria-pressed={selNode.criticality === c}
                        onClick={() => setPendingCrit(c)}
                        data-testid={`crit-stop-${c}`}
                      >
                        {c.toFixed(1)}
                      </button>
                    ))}
                  </fieldset>
                  <p className="dim" style={{ fontSize: 12, marginTop: 6 }}>
                    Currently {selNode.criticality.toFixed(1)} (
                    {selNode.criticalitySource}).
                    {selNode.criticalitySource === "human" &&
                      " A human correction survives every re-crawl."}
                  </p>
                  {pendingCrit !== null && pendingCrit !== selNode.criticality && (
                    <div
                      style={{
                        marginTop: 10,
                        display: "flex",
                        flexDirection: "column",
                        gap: 8,
                      }}
                    >
                      <input
                        type="text"
                        placeholder="Reason (required — audited)"
                        value={critReason}
                        onChange={(e) => setCritReason(e.target.value)}
                        style={{
                          border: "1px solid var(--line)",
                          borderRadius: 8,
                          padding: "7px 10px",
                          font: "inherit",
                          fontSize: 13,
                        }}
                      />
                      <button
                        type="button"
                        className="btn btn--ink btn--tiny"
                        disabled={!critReason.trim() || saving}
                        onClick={() => void saveCriticality(selNode.id, pendingCrit)}
                      >
                        {saving ? "Saving…" : "Save override"}
                      </button>
                      {saveError && (
                        <p style={{ fontSize: 12.5, color: "var(--block)" }}>
                          {saveError}
                        </p>
                      )}
                    </div>
                  )}
                </div>

                <div className="node-panel__section">
                  <h3>Incoming dependencies</h3>
                  {edges.filter((e) => e.dstId === selNode.id).length === 0 ? (
                    <p className="dim" style={{ fontSize: 13 }}>
                      Nothing depends on this node.
                    </p>
                  ) : (
                    edges
                      .filter((e) => e.dstId === selNode.id)
                      .slice(0, 8)
                      .map((e) => (
                        <div key={e.id} className="rationale-item">
                          <strong style={{ fontSize: 13 }}>
                            {nodeById.get(e.srcId)?.name ?? `#${e.srcId}`}
                          </strong>
                          <div className="rationale-item__meta" style={{ marginTop: 6 }}>
                            <span className="tag">{e.kind}</span>
                            <ProvenanceTag
                              provenance={e.provenance as "static_parse"}
                              confidence={e.confidence}
                            />
                          </div>
                        </div>
                      ))
                  )}
                </div>
              </>
            )}
          </aside>
        </div>
      )}
    </div>
  );
}
