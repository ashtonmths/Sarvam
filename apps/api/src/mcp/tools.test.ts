import type { BlastRow, VerdictResult } from "@sadhak/shared/types";
import { describe, expect, it } from "vitest";
import type { AskAnswer } from "../documents/ask.js";
import {
  askDocsInput,
  ingestDocumentInput,
  ingestedByLabel,
  nodeRefInput,
  proposeChangeInput,
  renderAskText,
  renderIngestText,
  renderVerdictText,
} from "./tools.js";

/**
 * The MCP surface's two I/O-free halves: the text a model reads, and the
 * schemas that decide what it is even allowed to say.
 *
 * `renderVerdictText` is the only part of the gate whose *audience is a
 * language model*, which makes its wording load-bearing in a way prose usually
 * is not — a BLOCK that does not say "not executed" invites the agent to
 * report success to its human, and one that does not say "do not retry"
 * invites a loop. Those two sentences are asserted here as contract, not as
 * style.
 */

function blastRow(overrides: Partial<BlastRow> = {}): BlastRow {
  return {
    nodeId: 1,
    name: "Invoices.vat_rate",
    kind: "field",
    hops: 1,
    criticality: 1,
    pathConfidence: 1,
    minEdgeConfidence: 1,
    impact: 1,
    busFactor: 2,
    path: [],
    ...overrides,
  };
}

function verdictResult(overrides: Partial<VerdictResult> = {}): VerdictResult {
  return {
    id: "00000000-0000-0000-0000-000000000000",
    verdict: "APPROVE",
    change: {
      target: "field",
      operation: "delete",
      connector: "postgres",
      externalId: "billing/public/invoices/vat_rate",
    },
    impacted: [],
    evidence: [],
    computedInMs: 7,
    graphVersion: 3,
    explanation: null,
    explanationState: "pending",
    ...overrides,
  };
}

describe("renderVerdictText", () => {
  it("tells the agent a BLOCK was not executed and must not be retried", () => {
    // The whole product's promise, in the register the reader actually parses.
    // An agent that reads "blocked" but not "not executed" reports a change it
    // never made; one that reads neither retries until the rate limiter stops
    // it.
    const text = renderVerdictText(verdictResult({ verdict: "BLOCK" }), false);

    expect(text).toContain("BLOCKED — this change was NOT executed and will not be.");
    expect(text).toContain("Do not retry this change.");
    expect(text).toContain("Ask a human, or propose a safer alternative.");
  });

  it("does not tell the agent to stop when the verdict allows the change", () => {
    // A WARN that carries the BLOCK's closing instruction is a false block:
    // the agent stops on a change it was permitted to make.
    const warn = renderVerdictText(verdictResult({ verdict: "WARN" }), false);
    const approve = renderVerdictText(verdictResult({ verdict: "APPROVE" }), false);

    expect(warn).toContain(
      "WARNING — this change is allowed but has a real blast radius.",
    );
    expect(warn).not.toContain("Do not retry");
    expect(approve).toContain("APPROVED — no dependency crosses a risk threshold.");
    expect(approve).not.toContain("Do not retry");
  });

  it("names the change it is answering about", () => {
    const text = renderVerdictText(
      verdictResult({
        change: {
          target: "workflow",
          operation: "disable",
          connector: "n8n",
          externalId: "wf_42",
        },
      }),
      false,
    );

    expect(text).toContain('Change: disable workflow "wf_42"');
  });

  it("lists every evidence line, since that is the appeal a human reads", () => {
    const text = renderVerdictText(
      verdictResult({
        verdict: "BLOCK",
        evidence: [
          {
            rule: "impact 0.90 >= 0.8 over trusted edges",
            nodeId: 2,
            name: "Revenue report",
            impact: 0.9,
          },
          {
            rule: "only one person can explain this dependency",
            nodeId: 3,
            name: "Payout job",
            impact: 0.4,
          },
        ],
      }),
      false,
    );

    expect(text).toContain("Why:");
    expect(text).toContain(
      "- impact 0.90 >= 0.8 over trusted edges → Revenue report (impact 0.90)",
    );
    expect(text).toContain(
      "- only one person can explain this dependency → Payout job (impact 0.40)",
    );
  });

  it("shows the top five impacted nodes but reports the true total", () => {
    // Truncation without the count is the failure mode that matters: an agent
    // told about five nodes when forty are reachable will describe the change
    // as small to the person deciding whether to override.
    const impacted = Array.from({ length: 40 }, (_, i) =>
      blastRow({ nodeId: i + 1, name: `node_${i + 1}`, impact: 1 - i / 100 }),
    );

    const text = renderVerdictText(verdictResult({ verdict: "WARN", impacted }), false);

    expect(text).toContain("Blast radius (40 nodes reached):");
    expect(text).toContain("- node_1 (field) impact 1.00, 1 hop(s)");
    expect(text).toContain("- node_5 (field)");
    expect(text).not.toContain("- node_6 (field)");
  });

  it("omits both sections when there is nothing to put in them", () => {
    const text = renderVerdictText(verdictResult({ verdict: "APPROVE" }), false);

    expect(text).not.toContain("Why:");
    expect(text).not.toContain("Blast radius");
  });

  it("reports the deterministic compute time, which is the no-model claim", () => {
    const text = renderVerdictText(verdictResult({ computedInMs: 12 }), false);

    expect(text).toContain("Computed deterministically in 12ms.");
  });

  it("says a dry run was a simulation, and says nothing of the sort otherwise", () => {
    const simulated = renderVerdictText(verdictResult({ verdict: "BLOCK" }), true);
    const enforced = renderVerdictText(verdictResult({ verdict: "BLOCK" }), false);

    expect(simulated).toContain(
      "This was a simulation; nothing was recorded as enforcement.",
    );
    expect(enforced).not.toContain("simulation");
  });

  it("still refuses clearly on a dry-run BLOCK", () => {
    // Simulated or not, the answer to "may I" is no. The agent must not read a
    // dry run as permission.
    const text = renderVerdictText(verdictResult({ verdict: "BLOCK" }), true);

    expect(text).toContain("NOT executed");
    expect(text).toContain("Do not retry this change.");
  });
});

describe("proposeChangeInput", () => {
  it("defaults dry_run to false, so an omitted flag enforces", () => {
    // The safe default is the enforcing one: a caller who forgets the flag
    // must not silently get a simulation it then treats as a real verdict.
    const parsed = proposeChangeInput.parse({
      change: {
        target: "field",
        operation: "delete",
        connector: "postgres",
        externalId: "billing/public/invoices/vat_rate",
      },
    });

    expect(parsed.dry_run).toBe(false);
  });

  it("refuses an operation that does not belong to its target", () => {
    // The discriminated union is the reason a change the engine cannot receive
    // is not composable by any caller — including one improvising JSON.
    const attempt = () =>
      proposeChangeInput.parse({
        change: {
          target: "field",
          operation: "disable",
          connector: "postgres",
          externalId: "x",
        },
      });

    expect(attempt).toThrow();
  });

  it("refuses a connector that cannot own that target", () => {
    // n8n has workflows, not fields.
    const attempt = () =>
      proposeChangeInput.parse({
        change: {
          target: "field",
          operation: "delete",
          connector: "n8n",
          externalId: "x",
        },
      });

    expect(attempt).toThrow();
  });

  it("refuses an empty external id rather than resolving nothing", () => {
    const attempt = () =>
      proposeChangeInput.parse({
        change: {
          target: "field",
          operation: "delete",
          connector: "postgres",
          externalId: "",
        },
      });

    expect(attempt).toThrow();
  });

  it("keeps the agent name when the caller supplies one", () => {
    const parsed = proposeChangeInput.parse({
      change: {
        target: "credential",
        operation: "revoke",
        connector: "slack",
        externalId: "cred_1",
        agent: "claude-code",
      },
      dry_run: true,
    });

    expect(parsed.change.agent).toBe("claude-code");
    expect(parsed.dry_run).toBe(true);
  });
});

function askAnswer(overrides: Partial<AskAnswer> = {}): AskAnswer {
  return {
    answer: "Finance asked for it before the quarter close [1].",
    grounded: true,
    sources: [
      {
        n: 1,
        kind: "document",
        title: "Billing sync handover",
        speaker: "Priya",
        permalink: "https://sadhak.test/app/documents/4#chunk-2",
        occurredAt: new Date("2026-03-11T09:30:00Z"),
        excerpt: "we kept vat_rate\n  writing until the EU report moved off it",
      },
    ],
    ...overrides,
  };
}

describe("renderAskText", () => {
  it("keeps a permalink on every source, which is what makes the answer checkable", () => {
    // The agent is a relay to a human who cannot see this tool call. An answer
    // that reaches them without links is a claim about their own organisation
    // that they have no way to verify.
    const text = renderAskText(askAnswer(), "why do we still write vat_rate?");

    expect(text).toContain("Finance asked for it before the quarter close [1].");
    expect(text).toContain("[1] Billing sync handover (2026-03-11, Priya)");
    expect(text).toContain("https://sadhak.test/app/documents/4#chunk-2");
    expect(text).toContain("Keep the citations when you relay this.");
  });

  it("lists a source the model never cited", () => {
    // The reader decides whether the answer is supported, which they cannot do
    // if the evidence is filtered to whatever the model happened to mention.
    const text = renderAskText(
      askAnswer({
        answer: "The notes only cover the report, not the field.",
        sources: [
          ...askAnswer().sources,
          {
            n: 2,
            kind: "document",
            title: "Q1 planning",
            speaker: null,
            permalink: "https://sadhak.test/app/documents/9#chunk-0",
            occurredAt: null,
            excerpt: "nothing decided on billing",
          },
        ],
      }),
      "why do we still write vat_rate?",
    );

    expect(text).toContain("[2] Q1 planning (undated)");
    expect(text).toContain("https://sadhak.test/app/documents/9#chunk-0");
  });

  it("flattens the newlines inside an excerpt so the source list stays one line each", () => {
    // Chunk bodies carry the transcript's own line breaks. Pasted raw, they
    // make a numbered list ambiguous about where one source ends.
    const text = renderAskText(askAnswer(), "why?");

    expect(text).toContain("we kept vat_rate writing until the EU report moved off it");
  });

  it("returns the abstention alone when retrieval found nothing", () => {
    // No sources means no citation block to render, and the sentence is
    // already the whole answer.
    const text = renderAskText(
      askAnswer({ answer: "Nothing covers that.", grounded: false, sources: [] }),
      "what is our deploy cadence?",
    );

    expect(text).toBe("Nothing covers that.");
    expect(text).not.toContain("Sources:");
  });

  it("tells the agent not to answer from its own knowledge when the model is unavailable", () => {
    // The dangerous branch: prose is missing but eight relevant passages are
    // present, and an agent that treats the gap as its own to fill produces
    // exactly the fabrication the grounding prompt exists to prevent.
    const text = renderAskText(
      askAnswer({
        answer: "",
        grounded: false,
        unavailable: "The model is switched off for this deployment.",
      }),
      "why do we still write vat_rate?",
    );

    expect(text).toContain("The model is switched off for this deployment.");
    expect(text).toContain(
      'Do not answer "why do we still write vat_rate?" from your own knowledge.',
    );
    expect(text).toContain("https://sadhak.test/app/documents/4#chunk-2");
  });
});

describe("askDocsInput", () => {
  it("accepts a question in prose", () => {
    expect(
      askDocsInput.parse({ question: "why did we drop the vat_rate sync?" }).question,
    ).toBe("why did we drop the vat_rate sync?");
  });

  it("refuses input too short to retrieve on and a pasted document", () => {
    // The same bounds as POST /ask. A two-character query matches everything;
    // a 500+ character one is a document, and the tool that reads documents is
    // this one.
    expect(() => askDocsInput.parse({ question: "hi" })).toThrow();
    expect(() => askDocsInput.parse({ question: "x".repeat(501) })).toThrow();
  });
});

describe("ingestDocumentInput", () => {
  it("defaults source to a paste, so an omitted flag never overclaims", () => {
    // The safe default is the one that does not invent provenance. An agent
    // that forgets the field must not have its paste recorded as a
    // transcription, nor a transcription silently recorded as a paste — the
    // former is a lie about a document, and the latter is the one that
    // matters, so it is the caller's job to set it and say so.
    const parsed = ingestDocumentInput.parse({ title: "Standup", text: "Priya: hi." });

    expect(parsed.source).toBe("pasted_text");
  });

  it("accepts the image source an agent sets after reading a screenshot", () => {
    const parsed = ingestDocumentInput.parse({
      title: "Whiteboard",
      text: "Ledger writes to the queue.",
      source: "image",
    });

    expect(parsed.source).toBe("image");
  });

  it("refuses a source it has no provenance wording for", () => {
    // The enum is the reason a document cannot be labelled with an origin the
    // document page would not know how to describe to a reader.
    expect(() =>
      ingestDocumentInput.parse({ title: "x", text: "y", source: "audio" }),
    ).toThrow();
  });

  it("refuses an empty document and an untitled one", () => {
    expect(() => ingestDocumentInput.parse({ title: "Standup", text: "" })).toThrow();
    expect(() => ingestDocumentInput.parse({ title: "", text: "Priya: hi." })).toThrow();
  });

  it("refuses an occurred_at that is not a real offset-bearing timestamp", () => {
    // "When the meeting happened" drives ordering and the date on every
    // citation. A bare date string would be silently read as midnight UTC.
    expect(() =>
      ingestDocumentInput.parse({ title: "x", text: "y", occurred_at: "11 March" }),
    ).toThrow();
    expect(
      ingestDocumentInput.parse({
        title: "x",
        text: "y",
        occurred_at: "2026-03-11T09:30:00Z",
      }).occurred_at,
    ).toBe("2026-03-11T09:30:00Z");
  });
});

describe("ingestedByLabel", () => {
  const ctx = { orgId: 1, apiKeyId: 42, scopes: [], clientName: "claude" };

  it("credits the key and the client for a paste", () => {
    expect(ingestedByLabel(ctx, "pasted_text")).toBe("api_key:42 via claude");
  });

  it("says in words that an image was transcribed rather than copied", () => {
    // The audience is whoever follows a citation into this document, and
    // `source=image` means nothing to them. The sentence has to.
    const label = ingestedByLabel(ctx, "image");

    expect(label).toContain("api_key:42");
    expect(label).toContain("read from an image by claude");
    expect(label).toContain("not a verbatim copy");
  });

  it("still names an unidentified client rather than leaving a blank", () => {
    const label = ingestedByLabel({ orgId: 1, apiKeyId: 7, scopes: [] }, "pasted_text");

    expect(label).toBe("api_key:7 via an MCP client");
  });

  it("stays inside the column, whatever the client calls itself", () => {
    // `uploaded_by` is capped at 200 characters by the upload schema, and a
    // client name is attacker-influenced text from the initialize handshake.
    // Overflowing it would fail the insert *after* chunking succeeded.
    const label = ingestedByLabel(
      { orgId: 1, apiKeyId: 7, scopes: [], clientName: "x".repeat(500) },
      "image",
    );

    expect(label.length).toBeLessThanOrEqual(200);
  });
});

describe("renderIngestText", () => {
  const stored = {
    id: 12,
    title: "Billing sync standup",
    chunkCount: 3,
    duplicate: false,
  };

  it("names the document it stored and warns that semantic search lags", () => {
    // The agent's next instinct is to search for what it just ingested. Left
    // unsaid, a text-only hit reads as a failed ingest and invites a retry.
    const text = renderIngestText(stored, "pasted_text");

    expect(text).toContain(
      'Stored "Billing sync standup" as document 12, in 3 chunk(s).',
    );
    expect(text).toContain("Text search finds it now");
  });

  it("tells the agent to pass the image caveat on to its human", () => {
    const text = renderIngestText(stored, "image");

    expect(text).toContain("read from an image rather than pasted verbatim");
    expect(text).toContain("Tell your human the same thing.");
  });

  it("says nothing about images when nothing was transcribed", () => {
    expect(renderIngestText(stored, "pasted_text")).not.toContain("image");
  });

  it("says a duplicate wrote nothing and must not be retried", () => {
    // Both halves matter and they fail in opposite directions: an agent that
    // reads this as success reports two meetings ingested, and one that reads
    // it as an error retries until something gives.
    const text = renderIngestText({ ...stored, duplicate: true }, "pasted_text");

    expect(text).toContain("Already stored — nothing was written.");
    expect(text).toContain("document 12");
    expect(text).toContain("Do not retry this ingest.");
    expect(text).not.toContain("Stored ");
  });
});

describe("nodeRefInput", () => {
  it("accepts every connector the graph can hold", () => {
    for (const connector of ["n8n", "airtable", "postgres", "github", "slack"] as const) {
      expect(nodeRefInput.parse({ connector, externalId: "x" }).connector).toBe(
        connector,
      );
    }
  });

  it("refuses a connector the graph has never heard of", () => {
    expect(() =>
      nodeRefInput.parse({ connector: "salesforce", externalId: "x" }),
    ).toThrow();
  });

  it("refuses an empty external id", () => {
    expect(() => nodeRefInput.parse({ connector: "postgres", externalId: "" })).toThrow();
  });
});
