import { describe, expect, it } from "vitest";
import { __testing } from "./admin.js";

const { extractFailure, MAX_ERROR_MESSAGE } = __testing;

/**
 * These assert against the shape the running 1.75.2 instance returns, not the
 * shape its OpenAPI document describes. The two disagree, and the document
 * loses.
 */
describe("extractFailure", () => {
  const base = {
    id: 42,
    workflowId: "wf-1",
    mode: "trigger",
    startedAt: "2026-08-01T10:00:00.000Z",
    stoppedAt: "2026-08-01T10:00:01.000Z",
    workflowData: { name: "Nightly sync" },
    data: {
      resultData: {
        lastNodeExecuted: "Postgres",
        error: { message: "connection refused" },
      },
    },
  };

  it("keeps the failing node and message", () => {
    const failure = extractFailure(base);
    expect(failure).toMatchObject({
      id: 42,
      workflowId: "wf-1",
      workflowName: "Nightly sync",
      failedNode: "Postgres",
      errorMessage: "connection refused",
    });
  });

  /**
   * The privacy boundary. `runData` holds the actual rows that flowed through
   * every node in the run; if it can reach the return value it can reach the
   * database, and this table is not a place customer records belong.
   */
  it("drops run data entirely", () => {
    const failure = extractFailure({
      ...base,
      data: {
        resultData: {
          ...base.data.resultData,
          runData: {
            Postgres: [{ data: { main: [[{ json: { email: "person@example.com" } }]] } }],
          },
        },
      },
    } as never);

    expect(JSON.stringify(failure)).not.toContain("person@example.com");
    expect(failure).not.toHaveProperty("runData");
  });

  /** An error string is one JSON.stringify(row) away from being data too. */
  it("truncates a long error message", () => {
    const failure = extractFailure({
      ...base,
      data: { resultData: { error: { message: "x".repeat(5_000) } } },
    });
    expect(failure?.errorMessage).toHaveLength(MAX_ERROR_MESSAGE);
  });

  it("falls back to description when there is no message", () => {
    const failure = extractFailure({
      ...base,
      data: { resultData: { error: { description: "node timed out" } } },
    });
    expect(failure?.errorMessage).toBe("node timed out");
  });

  /** includeData=false, or a run that failed before producing result data. */
  it("survives an execution with no data at all", () => {
    const failure = extractFailure({ id: 7, workflowId: "wf-2" });
    expect(failure).toMatchObject({
      id: 7,
      failedNode: null,
      errorMessage: null,
    });
  });

  /** The id is the dedupe anchor; a row without one cannot be stored safely. */
  it("rejects an execution with no usable id", () => {
    expect(extractFailure({ workflowId: "wf-3" })).toBeNull();
    expect(extractFailure({ id: "not-a-number", workflowId: "wf-3" })).toBeNull();
  });

  it("accepts a numeric id delivered as a string", () => {
    expect(extractFailure({ id: "1001", workflowId: "wf-4" })?.id).toBe(1001);
  });
});
