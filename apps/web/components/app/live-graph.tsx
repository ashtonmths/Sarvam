"use client";

import Link from "next/link";
import { useEffect, useMemo, useRef, useState } from "react";
import { ApiError, api, type GraphEdge, type GraphNode, type Page } from "../../lib/api";
import { useQuery } from "../../lib/queries";
import { Select } from "./select";
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

/** Kinds that read as systems rather than members of one. */
const MAJOR_KINDS = new Set(["table", "report", "workflow", "service", "endpoint"]);

/** Chip geometry, derived from the label so anchors and halos line up. */
function pillMetrics(node: GraphNode) {
  const major = MAJOR_KINDS.has(node.kind);
  const label = node.name.length > 26 ? `${node.name.slice(0, 25)}…` : node.name;
  const fontSize = major ? 11.5 : 10.5;
  const padX = major ? 13 : 10;
  const w = Math.round(label.length * fontSize * 0.62 + padX * 2 + 13);
  const h = major ? 30 : 23;
  return { label, major, fontSize, padX, w, h };
}

const DASH: Record<string, string | undefined> = {
  static_parse: undefined,
  runtime_observed: "6 4",
  llm_inferred: "2 4",
};

const CRIT_STOPS = [1.0, 0.7, 0.4, 0.1];

const VB_HOME = { x: 0, y: 0, w: 1120, h: 700 };

export function LiveGraph({ initialQuery = "" }: { initialQuery?: string }) {
  const [view, setView] = useState<"map" | "list">("map");
  const [selected, setSelected] = useState<number | null>(null);
  const [hovered, setHovered] = useState<number | null>(null);
  const [q, setQ] = useState(initialQuery);
  const [kind, setKind] = useState("all");
  const [critReason, setCritReason] = useState("");
  const [pendingCrit, setPendingCrit] = useState<number | null>(null);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);

  // The camera. Wheel zooms toward the pointer, dragging the canvas pans.
  const [vb, setVb] = useState(VB_HOME);
  const svgRef = useRef<SVGSVGElement>(null);
  const drag = useRef<{ px: number; py: number; vx: number; vy: number } | null>(null);

  useEffect(() => {
    const svg = svgRef.current;
    if (!svg) return;
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      setVb((prev) => {
        const rect = svg.getBoundingClientRect();
        const fx = (e.clientX - rect.left) / rect.width;
        const fy = (e.clientY - rect.top) / rect.height;
        const scale = e.deltaY > 0 ? 1.12 : 1 / 1.12;
        const w = Math.min(2400, Math.max(360, prev.w * scale));
        const h = w * (VB_HOME.h / VB_HOME.w);
        return {
          x: prev.x + (prev.w - w) * fx,
          y: prev.y + (prev.h - h) * fy,
          w,
          h,
        };
      });
    };
    svg.addEventListener("wheel", onWheel, { passive: false });
    return () => svg.removeEventListener("wheel", onWheel);
  }, []);

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
    const height = 620;

    // Neighbors across both edge directions, for barycenter ordering.
    const neighbors = new Map<number, number[]>();
    for (const edge of edges) {
      (neighbors.get(edge.srcId) ?? neighbors.set(edge.srcId, []).get(edge.srcId))?.push(
        edge.dstId,
      );
      (neighbors.get(edge.dstId) ?? neighbors.set(edge.dstId, []).get(edge.dstId))?.push(
        edge.srcId,
      );
    }

    // Start alphabetical, then pull each node toward the average height of
    // what it touches. Three sweeps untangles a graph this size completely.
    const y = new Map<number, number>();
    const ordered = new Map<number, GraphNode[]>();
    for (const layer of layers) {
      const members = (byLayer.get(layer) ?? [])
        .slice()
        .sort((a, b) => a.name.localeCompare(b.name));
      ordered.set(layer, members);
      members.forEach((node, i) => {
        y.set(node.id, (i + 1) / (members.length + 1));
      });
    }
    for (let sweep = 0; sweep < 3; sweep += 1) {
      for (const layer of sweep % 2 === 0 ? layers : [...layers].reverse()) {
        const members = ordered.get(layer) ?? [];
        members.sort((a, b) => {
          const bary = (n: GraphNode) => {
            const ns = neighbors.get(n.id) ?? [];
            const known = ns.filter((id) => y.has(id));
            if (known.length === 0) return y.get(n.id) ?? 0.5;
            return known.reduce((s, id) => s + (y.get(id) ?? 0.5), 0) / known.length;
          };
          return bary(a) - bary(b);
        });
        members.forEach((node, i) => {
          y.set(node.id, (i + 1) / (members.length + 1));
        });
      }
    }

    const out = new Map<number, { x: number; y: number }>();
    layers.forEach((layer, layerIndex) => {
      const x = 150 + layerIndex * (820 / Math.max(1, layers.length - 1 || 1));
      for (const node of ordered.get(layer) ?? []) {
        out.set(node.id, {
          x: layers.length === 1 ? 560 : x,
          y: (y.get(node.id) ?? 0.5) * height + 40,
        });
      }
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
        <Select
          value={kind}
          onChange={setKind}
          label="Filter by kind"
          options={[
            { value: "all", label: "All kinds" },
            ...kinds.map((k) => ({ value: k, label: k })),
          ]}
        />
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
              ref={svgRef}
              viewBox={`${vb.x} ${vb.y} ${vb.w} ${vb.h}`}
              aria-label="Dependency graph. Use the list view for keyboard navigation."
              onPointerDown={(e) => {
                if ((e.target as Element).closest(".graph-node")) return;
                drag.current = { px: e.clientX, py: e.clientY, vx: vb.x, vy: vb.y };
                (e.currentTarget as SVGSVGElement).setPointerCapture(e.pointerId);
              }}
              onPointerMove={(e) => {
                const d = drag.current;
                if (!d) return;
                const rect = e.currentTarget.getBoundingClientRect();
                const perPx = vb.w / rect.width;
                setVb((prev) => ({
                  ...prev,
                  x: d.vx - (e.clientX - d.px) * perPx,
                  y: d.vy - (e.clientY - d.py) * perPx,
                }));
              }}
              onPointerUp={() => {
                drag.current = null;
              }}
            >
              {edges
                .filter((e) => visibleIds.has(e.srcId) && visibleIds.has(e.dstId))
                .map((e) => {
                  const s = positions.get(e.dstId);
                  const t = positions.get(e.srcId);
                  const sNode = nodeById.get(e.dstId);
                  const tNode = nodeById.get(e.srcId);
                  if (!s || !t || !sNode || !tNode) return null;
                  // The dependency sits left, so the thread leaves its right
                  // edge and lands on the dependent's left edge.
                  const sw = pillMetrics(sNode).w / 2;
                  const tw = pillMetrics(tNode).w / 2;
                  const flip = s.x > t.x;
                  const x1 = flip ? s.x - sw : s.x + sw;
                  const x2 = flip ? t.x + tw : t.x - tw;
                  const mid = (x1 + x2) / 2;
                  const inRipple =
                    selected !== null &&
                    (e.dstId === selected || impacted.has(e.dstId)) &&
                    impacted.has(e.srcId);
                  const nearHover =
                    hovered !== null && (e.srcId === hovered || e.dstId === hovered);
                  return (
                    <path
                      key={e.id}
                      d={`M ${x1} ${s.y} C ${mid} ${s.y}, ${mid} ${t.y}, ${x2} ${t.y}`}
                      fill="none"
                      stroke={
                        inRipple
                          ? "var(--block)"
                          : nearHover
                            ? "var(--thread)"
                            : "var(--ink-faint)"
                      }
                      strokeWidth={inRipple || nearHover ? 1.8 : 1.2}
                      strokeOpacity={
                        inRipple ? 0.85 : nearHover ? 0.8 : 0.2 + e.confidence * 0.3
                      }
                      strokeDasharray={DASH[e.provenance]}
                    />
                  );
                })}

              {visible.map((n) => {
                const pos = positions.get(n.id);
                if (!pos) return null;
                const pill = pillMetrics(n);
                const hop = impacted.get(n.id);
                const color = CONNECTOR_COLOR[n.connector] ?? "#8a8f99";
                const dimmed =
                  selected !== null && hop === undefined && selected !== n.id;
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
                    opacity={dimmed ? 0.28 : 1}
                    onClick={() => setSelected(n.id)}
                    onMouseEnter={() => setHovered(n.id)}
                    onMouseLeave={() => setHovered(null)}
                    onFocus={() => setHovered(n.id)}
                    onBlur={() => setHovered(null)}
                    onKeyDown={(e) => {
                      if (e.key === "Enter" || e.key === " ") {
                        e.preventDefault();
                        setSelected(n.id);
                      }
                    }}
                  >
                    {/* The locked visual: opacity is the impact score. */}
                    {hop !== undefined && (
                      <rect
                        className="graph-ripple"
                        x={pos.x - pill.w / 2 - 7}
                        y={pos.y - pill.h / 2 - 7}
                        width={pill.w + 14}
                        height={pill.h + 14}
                        rx={pill.h / 2 + 7}
                        fill="var(--block)"
                        style={{
                          opacity: n.criticality * 0.6 ** (hop - 1),
                          animationDelay: `${hop * 120}ms`,
                        }}
                      />
                    )}
                    <rect
                      className="gpill"
                      x={pos.x - pill.w / 2}
                      y={pos.y - pill.h / 2}
                      width={pill.w}
                      height={pill.h}
                      rx={pill.h / 2}
                      fill="var(--card)"
                      stroke="var(--line)"
                      strokeWidth={1}
                      strokeDasharray={n.state === "stale" ? "4 3" : undefined}
                    />
                    <circle
                      cx={pos.x - pill.w / 2 + pill.padX + 2}
                      cy={pos.y}
                      r={3.2}
                      fill={color}
                    />
                    <text
                      x={pos.x - pill.w / 2 + pill.padX + 11}
                      y={pos.y + pill.fontSize * 0.36}
                      className={pill.major ? "gtext gtext--major" : "gtext"}
                    >
                      {pill.label}
                    </text>
                  </g>
                );
              })}
            </svg>

            <div className="graph-controls" aria-hidden="true">
              <button
                type="button"
                title="Zoom in"
                onClick={() =>
                  setVb((p) => {
                    const w = Math.max(360, p.w / 1.25);
                    const h = w * (VB_HOME.h / VB_HOME.w);
                    return { x: p.x + (p.w - w) / 2, y: p.y + (p.h - h) / 2, w, h };
                  })
                }
              >
                +
              </button>
              <button
                type="button"
                title="Zoom out"
                onClick={() =>
                  setVb((p) => {
                    const w = Math.min(2400, p.w * 1.25);
                    const h = w * (VB_HOME.h / VB_HOME.w);
                    return { x: p.x + (p.w - w) / 2, y: p.y + (p.h - h) / 2, w, h };
                  })
                }
              >
                −
              </button>
              <button type="button" title="Reset view" onClick={() => setVb(VB_HOME)}>
                ⌂
              </button>
            </div>

            <div className="graph-legend" aria-hidden="true">
              {[...new Set(nodes.map((n) => n.connector))].sort().map((c) => (
                <span key={c}>
                  <b style={{ background: CONNECTOR_COLOR[c] ?? "#8a8f99" }} /> {c}
                </span>
              ))}
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
              <>
                <p style={{ fontSize: 14, color: "var(--ink-soft)" }}>
                  Select a node to see what depends on it. The ripple&rsquo;s opacity is
                  the impact score — darker is worse. Dependencies sink left, dependents
                  rise right.
                </p>
                <div className="node-panel__section">
                  <h3>Start with the heavy ones</h3>
                  {nodes
                    .slice()
                    .sort(
                      (a, b) =>
                        b.criticality - a.criticality || a.name.localeCompare(b.name),
                    )
                    .slice(0, 3)
                    .map((n) => (
                      <button
                        key={n.id}
                        type="button"
                        className="node-suggest"
                        onClick={() => setSelected(n.id)}
                        data-testid={`graph-suggest-${n.id}`}
                      >
                        <span
                          className="node-suggest__dot"
                          style={{
                            background: CONNECTOR_COLOR[n.connector] ?? "#8a8f99",
                          }}
                        />
                        <span className="node-suggest__name">{n.name}</span>
                        <span className="node-suggest__crit">
                          {n.criticality.toFixed(1)}
                        </span>
                      </button>
                    ))}
                </div>
              </>
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
                    <Link
                      href="/app/simulate"
                      className="btn btn--ink btn--small"
                      style={{ marginTop: 12, width: "100%", justifyContent: "center" }}
                      data-testid="graph-simulate-cta"
                    >
                      Dry-run a change here
                    </Link>
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
