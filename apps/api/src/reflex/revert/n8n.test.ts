import { describe, expect, it } from "vitest";
import { __testing } from "./n8n.js";

const { restorable } = __testing;

/**
 * The regression is not hypothetical: every n8n revert returned
 * `400 request/body must NOT have additional properties`, because the body was
 * built from a snapshot of what the API returned rather than from what its PUT
 * accepts. Reflex could detect a workflow change and never undo one.
 */
describe("restorable", () => {
  const snapshot = {
    id: "shf1OemAk3uvsiNl",
    name: "Nightly sync",
    active: true,
    createdAt: "2026-08-01T10:00:00.000Z",
    updatedAt: "2026-08-01T11:00:00.000Z",
    versionId: "v-123",
    tags: [{ id: "t1", name: "prod" }],
    meta: { templateId: "x" },
    nodes: [{ name: "Webhook", type: "n8n-nodes-base.webhook" }],
    connections: { Webhook: { main: [[]] } },
    settings: { executionOrder: "v1" },
  };

  it("sends only the four fields n8n accepts", () => {
    expect(Object.keys(restorable(snapshot)).sort()).toEqual([
      "connections",
      "name",
      "nodes",
      "settings",
    ]);
  });

  it("drops every field that caused the 400", () => {
    const body = restorable(snapshot);
    for (const rejected of [
      "id",
      "active",
      "createdAt",
      "updatedAt",
      "versionId",
      "tags",
      "meta",
    ]) {
      expect(body).not.toHaveProperty(rejected);
    }
  });

  it("carries the structure through unchanged", () => {
    const body = restorable(snapshot);
    expect(body.name).toBe("Nightly sync");
    expect(body.nodes).toEqual(snapshot.nodes);
    expect(body.connections).toEqual(snapshot.connections);
  });

  /** n8n requires `settings`; a workflow captured without one must not 400. */
  it("defaults the fields n8n requires but the snapshot may lack", () => {
    const body = restorable({ name: "Bare" });
    expect(body).toEqual({ name: "Bare", nodes: [], connections: {}, settings: {} });
  });

  it("survives a null or empty snapshot rather than throwing", () => {
    expect(restorable(null)).toEqual({
      name: undefined,
      nodes: [],
      connections: {},
      settings: {},
    });
  });
});
