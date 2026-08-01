import type { ChangeDescriptor } from "@sadhak/shared/types";
import { type ExtractionResult, emptyExtraction } from "./types.js";

/**
 * n8n exported workflow JSON → change descriptors.
 *
 * v1 deliberately does **not** try to infer field-reference changes inside
 * step parameters. That is llm-inferred territory and has no business in a
 * hard gate: a guess that blocks someone's merge is the failure mode that
 * ends the account.
 */

interface WorkflowExport {
  id?: string;
  name?: string;
  active?: boolean;
  nodes?: Array<{ id?: string; name?: string; type?: string }>;
}

function parse(contents: string | null): WorkflowExport | null {
  if (!contents) return null;
  try {
    const parsed = JSON.parse(contents) as WorkflowExport;
    return typeof parsed === "object" && parsed !== null ? parsed : null;
  } catch {
    return null;
  }
}

export function extractFromN8n(
  file: string,
  baseContents: string | null,
  headContents: string | null,
): ExtractionResult {
  const result = emptyExtraction();

  const before = parse(baseContents);
  const after = parse(headContents);

  // The file appeared: a new workflow is not a change to anything existing.
  if (!before) return result;

  if (!before.id) {
    result.unknowns.push({
      file,
      reason: "workflow export carries no id — cannot resolve it to a node",
    });
    return result;
  }

  const workflowExternalId = `workflow/${before.id}`;

  // The file is gone from the head ref: the workflow was deleted.
  if (!after) {
    result.changes.push({
      target: "workflow",
      connector: "n8n",
      operation: "delete",
      externalId: workflowExternalId,
    });
    return result;
  }

  if (before.active === true && after.active === false) {
    result.changes.push({
      target: "workflow",
      connector: "n8n",
      operation: "disable",
      externalId: workflowExternalId,
    });
  }

  // Steps are diffed by node id, not by position: reordering a workflow is
  // not a deletion, and treating it as one would block harmless PRs.
  const afterIds = new Set(
    (after.nodes ?? []).map((n) => n.id ?? n.name).filter((v): v is string => Boolean(v)),
  );

  for (const node of before.nodes ?? []) {
    const nodeId = node.id ?? node.name;
    if (!nodeId || afterIds.has(nodeId)) continue;
    result.changes.push({
      target: "workflow",
      connector: "n8n",
      operation: "delete",
      externalId: `${workflowExternalId}/node/${nodeId}`,
    } satisfies ChangeDescriptor);
  }

  return result;
}

/** Which changed files this extractor should even look at. */
export function isN8nWorkflowFile(
  path: string,
  configuredPrefix: string | null,
): boolean {
  if (!path.endsWith(".json")) return false;
  if (configuredPrefix) return path.startsWith(configuredPrefix);
  return /(^|\/)(workflows?|n8n)\//i.test(path);
}
