import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { closePools, sql } from "../db.js";
import { EMBEDDING_DIMS } from "../embed.js";
import { LlmDisabledError } from "../llm.js";
import type { McpContext } from "./tools.js";
import { askDocs, ingestDocument } from "./tools.js";

/**
 * The two document tools against a real corpus: what `ask_docs` retrieves and
 * what it refuses to retrieve from another organisation, and what
 * `ingest_document` actually writes when an agent pastes a transcript.
 *
 * They share a file because they share a claim. Ingest is only worth anything
 * if the tool that answers questions can then find and cite what it stored, and
 * a suite that asserted the write and the read separately would keep passing
 * through the exact break that matters — a document that lands in the table and
 * never surfaces in an answer.
 *
 * Two things are stubbed, and the reasons differ.
 *
 * The *model* is stubbed as disabled because the prose it writes is asserted
 * against the grounding prompt elsewhere, and because the disabled branch is
 * the one that matters most for safety: retrieval succeeded, no answer was
 * written, and the agent must be told in so many words not to fill the gap
 * itself.
 *
 * The *embedder* is stubbed because loading bge-small-en costs a 130MB
 * download on a cold cache, and no other integration test drags that into the
 * suite. Every seeded chunk is given the same stub vector the query produces,
 * so the pgvector half of the hybrid query genuinely executes against real
 * Postgres — what is *not* asserted here is semantic ranking quality, which is
 * a property of the model rather than of this code. The tenancy test below is
 * the reason the stub is worth having at all: with identical vectors, an
 * unscoped vector branch would return the other organisation's chunk, and the
 * assertion would catch it.
 */

vi.mock("../llm.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../llm.js")>();
  return {
    ...actual,
    complete: vi.fn(async () => {
      throw new actual.LlmDisabledError("LLM_DISABLED is set");
    }),
  };
});

/** A unit vector of the right width. Identical for every text, by design. */
const STUB_VECTOR = Array.from({ length: 384 }, (_, i) => (i === 0 ? 1 : 0));

vi.mock("../embed.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../embed.js")>();
  return {
    ...actual,
    embed: vi.fn(async () => Array.from({ length: 384 }, (_, i) => (i === 0 ? 1 : 0))),
  };
});

async function seedOrg(slug: string): Promise<number> {
  const [row] = await sql<{ id: string }[]>`
    INSERT INTO organizations (name, slug) VALUES (${slug}, ${slug}) RETURNING id
  `;
  return Number(row?.id);
}

/** One document of one chunk — the smallest thing retrieval can return. */
async function seedDocument(
  orgId: number,
  title: string,
  body: string,
  speaker: string | null = null,
): Promise<{ documentId: number }> {
  const [doc] = await sql<{ id: string }[]>`
    INSERT INTO documents (org_id, title, content, content_hash, byte_size, occurred_at)
    VALUES (${orgId}, ${title}, ${body}, ${`hash-${title}-${orgId}`},
            ${body.length}, '2026-03-11T09:30:00Z')
    RETURNING id
  `;
  const documentId = Number(doc?.id);

  await sql`
    INSERT INTO document_chunks
      (org_id, document_id, ordinal, body, speaker, start_offset, end_offset,
       token_estimate, embedding)
    VALUES (${orgId}, ${documentId}, 0, ${body}, ${speaker}, 0, ${body.length},
            ${Math.ceil(body.length / 4)}, ${`[${STUB_VECTOR.join(",")}]`}::vector)
  `;

  return { documentId };
}

function ctxFor(orgId: number): McpContext {
  return { orgId, apiKeyId: 1, scopes: ["graph:read"] };
}

const HANDOVER =
  "We kept the vat_rate field writing after the migration because the EU VAT report still reads it every quarter. Finance asked us not to drop it until that report moves.";

beforeEach(async () => {
  await sql`TRUNCATE organizations, users CASCADE`;
});

afterAll(async () => {
  await closePools();
});

describe("ask_docs", () => {
  it("keeps the stub vector the same width the schema stores", () => {
    // The seed above would fail on insert if these ever diverged, but as a
    // message about vector width several layers from the constant that caused
    // it. Said plainly here instead.
    expect(STUB_VECTOR).toHaveLength(EMBEDDING_DIMS);
  });

  it("finds the passage that answers the question and cites where it came from", async () => {
    const orgId = await seedOrg("acme");
    const { documentId } = await seedDocument(
      orgId,
      "Billing sync handover",
      HANDOVER,
      "Priya",
    );

    const out = await askDocs(ctxFor(orgId), {
      question: "why do we still write the vat_rate field?",
    });

    expect(out.structured.sources).toHaveLength(1);
    const [source] = out.structured.sources;
    expect(source?.title).toBe("Billing sync handover");
    expect(source?.speaker).toBe("Priya");
    // The permalink resolves to the quoted span inside this deployment, not to
    // wherever the file originally came from.
    expect(source?.permalink).toContain(`/app/documents/${documentId}#chunk-0`);
    expect(source?.excerpt).toContain("EU VAT report");
    expect(out.text).toContain(`/app/documents/${documentId}#chunk-0`);
  });

  it("cannot read another organisation's documents, however exactly they are named", async () => {
    // The tenancy claim, asked in the most favourable possible way for a leak:
    // the question quotes the other org's document almost word for word, and
    // that org's chunk carries a vector identical to the query's — so both
    // halves of the hybrid query would return it if either were unscoped.
    const acme = await seedOrg("acme");
    const rival = await seedOrg("rival");
    await seedDocument(rival, "Rival handover", HANDOVER);

    const out = await askDocs(ctxFor(acme), {
      question: "why do we still write the vat_rate field for the EU VAT report?",
    });

    expect(out.structured.sources).toHaveLength(0);
    expect(out.structured.grounded).toBe(false);
    expect(out.text).toContain("Nothing in this organisation's documents covers that");
  });

  it("hands over the passages, and forbids invention, when the model is unavailable", async () => {
    // Retrieval already did the expensive part. An agent handed the passages
    // can still answer honestly; one handed an error, or handed silence,
    // answers from its own background knowledge about organisations in
    // general — which is indistinguishable from a real finding downstream.
    const orgId = await seedOrg("acme");
    await seedDocument(orgId, "Billing sync handover", HANDOVER);

    const out = await askDocs(ctxFor(orgId), {
      question: "why do we still write the vat_rate field?",
    });

    expect(out.structured.answer).toBe("");
    expect(out.structured.grounded).toBe(false);
    expect(out.structured.unavailable).toContain("switched off");
    expect(out.text).toContain("Do not answer");
    expect(out.text).toContain("from your own knowledge");
    expect(out.text).toContain("EU VAT report");
  });

  it("is a read: it records no decision and no enforcement", async () => {
    // The gate's tools write rows. This one must not, or every question an
    // agent asks pollutes the audit trail of changes actually proposed.
    const orgId = await seedOrg("acme");
    await seedDocument(orgId, "Billing sync handover", HANDOVER);

    await askDocs(ctxFor(orgId), { question: "why do we still write vat_rate?" });

    const [decisions] = await sql<{ count: string }[]>`
      SELECT count(*)::text AS count FROM gate_decisions WHERE org_id = ${orgId}
    `;
    const [verdicts] = await sql<{ count: string }[]>`
      SELECT count(*)::text AS count FROM verdicts WHERE org_id = ${orgId}
    `;

    expect(decisions?.count).toBe("0");
    expect(verdicts?.count).toBe("0");
  });
});

describe("ingest_document", () => {
  const TRANSCRIPT = [
    "Priya: we are keeping vat_rate for now.",
    "Sam: the EU VAT report still reads it every quarter.",
    "Priya: right, so finance asked us not to drop it until that moves.",
  ].join("\n");

  function ctxWithClient(orgId: number, clientName?: string): McpContext {
    return {
      orgId,
      apiKeyId: 42,
      scopes: ["connector:manage"],
      ...(clientName === undefined ? {} : { clientName }),
    };
  }

  it("stores a pasted transcript so ask_docs can find and cite it", async () => {
    // The round trip is the feature. Ingesting into a corpus that the question
    // tool cannot then reach would satisfy every assertion about writing rows
    // and none about the thing being useful.
    const orgId = await seedOrg("acme");

    const stored = await ingestDocument(ctxWithClient(orgId, "claude"), {
      title: "Billing sync standup",
      text: TRANSCRIPT,
      source: "pasted_text",
    });

    expect(stored.structured.duplicate).toBe(false);
    expect(stored.structured.chunk_count).toBeGreaterThan(0);

    const found = await askDocs(ctxFor(orgId), {
      question: "what did finance ask about vat_rate?",
    });

    expect(found.structured.sources.length).toBeGreaterThan(0);
    expect(found.structured.sources[0]?.title).toBe("Billing sync standup");
    expect(found.structured.sources[0]?.permalink).toContain(
      `/app/documents/${stored.structured.document_id}#chunk-`,
    );
  });

  it("runs a pasted transcript through the same chunker an upload uses", async () => {
    // Asserted through the chunker's speaker rule, which is its most
    // distinctive behaviour: a chunk is attributed only when it is one voice
    // throughout, because naming one of three speakers would be a claim the
    // chunk does not support. Getting both halves of that rule for free is
    // what calling `uploadDocument` buys; a bespoke ingest path here is how an
    // agent's transcript would start citing quotes to the wrong person.
    const orgId = await seedOrg("acme");

    const oneVoice = await ingestDocument(ctxWithClient(orgId), {
      title: "Priya's handover note",
      text: "Priya: we are keeping vat_rate until the EU VAT report moves off it.",
      source: "pasted_text",
    });
    const threeVoices = await ingestDocument(ctxWithClient(orgId), {
      title: "Billing sync standup",
      text: TRANSCRIPT,
      source: "pasted_text",
    });

    const [attributed] = await sql<{ speaker: string | null }[]>`
      SELECT speaker FROM document_chunks
      WHERE document_id = ${oneVoice.structured.document_id} ORDER BY ordinal
    `;
    const [mixed] = await sql<{ speaker: string | null }[]>`
      SELECT speaker FROM document_chunks
      WHERE document_id = ${threeVoices.structured.document_id} ORDER BY ordinal
    `;

    expect(attributed?.speaker).toBe("Priya");
    expect(mixed?.speaker).toBeNull();
  });

  it("records on the document that an image was transcribed, not copied", async () => {
    // The provenance claim. A sentence an agent read off a whiteboard photo
    // becomes an ordinary chunk the moment it is stored, indistinguishable in
    // a search result from one somebody actually typed — unless the document
    // itself says so, on the page a citation resolves to.
    const orgId = await seedOrg("acme");

    const stored = await ingestDocument(ctxWithClient(orgId, "claude"), {
      title: "Whiteboard, architecture review",
      text: "Ledger writes to the queue. Reporting reads the queue, never the table.",
      source: "image",
    });

    const [row] = await sql<{ uploaded_by: string }[]>`
      SELECT uploaded_by FROM documents WHERE id = ${stored.structured.document_id}
    `;

    expect(row?.uploaded_by).toContain("api_key:42");
    expect(row?.uploaded_by).toContain("claude");
    expect(row?.uploaded_by).toContain("not a verbatim copy");
    // And the agent is told to pass that on rather than presenting it as fact.
    expect(stored.text).toContain("read from an image");
    expect(stored.text).toContain("Tell your human");
  });

  it("says nothing about images when the text was pasted", async () => {
    const orgId = await seedOrg("acme");

    const stored = await ingestDocument(ctxWithClient(orgId, "claude"), {
      title: "Billing sync standup",
      text: TRANSCRIPT,
      source: "pasted_text",
    });

    const [row] = await sql<{ uploaded_by: string }[]>`
      SELECT uploaded_by FROM documents WHERE id = ${stored.structured.document_id}
    `;

    expect(row?.uploaded_by).not.toContain("image");
    expect(stored.text).not.toContain("image");
  });

  it("writes nothing the second time and tells the agent not to retry", async () => {
    // An agent that reads "stored" twice reports two meetings ingested, and an
    // agent that reads an error retries. Both are avoided by saying plainly
    // that the content is already there.
    const orgId = await seedOrg("acme");
    const first = await ingestDocument(ctxWithClient(orgId), {
      title: "Billing sync standup",
      text: TRANSCRIPT,
      source: "pasted_text",
    });
    const second = await ingestDocument(ctxWithClient(orgId), {
      title: "Billing sync standup (again)",
      text: TRANSCRIPT,
      source: "pasted_text",
    });

    expect(second.structured.duplicate).toBe(true);
    expect(second.structured.document_id).toBe(first.structured.document_id);
    expect(second.text).toContain("nothing was written");
    expect(second.text).toContain("Do not retry");

    const [row] = await sql<{ count: string }[]>`
      SELECT count(*)::text AS count FROM documents WHERE org_id = ${orgId}
    `;
    expect(row?.count).toBe("1");
  });

  it("attributes the write to the API key, not to the system", async () => {
    // `uploadDocument` writes a `system` row for its own bookkeeping. An org
    // reading its audit log needs to see that an agent added this document.
    const orgId = await seedOrg("acme");

    const stored = await ingestDocument(ctxWithClient(orgId, "claude"), {
      title: "Billing sync standup",
      text: TRANSCRIPT,
      source: "image",
    });

    const [row] = await sql<
      {
        actor_type: string;
        actor_id: string;
        metadata: Record<string, unknown>;
      }[]
    >`
      SELECT actor_type, actor_id, metadata FROM audit_log
      WHERE org_id = ${orgId} AND action = 'document.uploaded' AND actor_type = 'api_key'
    `;

    expect(row?.actor_id).toBe("42");
    expect(row?.metadata?.source).toBe("image");
    expect(row?.metadata?.mcpClient).toBe("claude");
    expect(String(row?.metadata?.title)).toBe("Billing sync standup");
    expect(stored.structured.document_id).toBeGreaterThan(0);
  });

  it("queues the new chunks for embedding rather than leaving them text-only", async () => {
    // Without the enqueue the document is findable lexically and invisible to
    // the semantic half — which looks like mediocre retrieval rather than a
    // missing job, and is exactly the failure embed.ts was written about.
    const orgId = await seedOrg("acme");
    // The job carries no org, so the org truncation between tests does not
    // clear it and a leftover row would make this pass without an enqueue.
    await sql`DELETE FROM jobs WHERE kind = 'document.embed'`;

    await ingestDocument(ctxWithClient(orgId), {
      title: "Billing sync standup",
      text: TRANSCRIPT,
      source: "pasted_text",
    });

    const [row] = await sql<{ count: string }[]>`
      SELECT count(*)::text AS count FROM jobs WHERE kind = 'document.embed'
    `;
    expect(row?.count).toBe("1");
  });

  it("keeps one organisation's ingest out of another's corpus", async () => {
    const acme = await seedOrg("acme");
    const rival = await seedOrg("rival");

    await ingestDocument(ctxWithClient(rival), {
      title: "Rival standup",
      text: TRANSCRIPT,
      source: "pasted_text",
    });

    const found = await askDocs(ctxFor(acme), {
      question: "what did finance ask about vat_rate?",
    });

    expect(found.structured.sources).toHaveLength(0);
  });

  it("refuses a filename the text path cannot read, before storing anything", async () => {
    // The image is never sent here, so a caller naming one is a caller who
    // misread the contract. Failing loudly beats storing a document whose
    // recorded origin is a file this system cannot open.
    const orgId = await seedOrg("acme");

    await expect(
      ingestDocument(ctxWithClient(orgId), {
        title: "Whiteboard",
        text: "Ledger writes to the queue.",
        source: "image",
        original_name: "whiteboard.png",
      }),
    ).rejects.toThrow(/text documents/i);

    const [row] = await sql<{ count: string }[]>`
      SELECT count(*)::text AS count FROM documents WHERE org_id = ${orgId}
    `;
    expect(row?.count).toBe("0");
  });
});

describe("the LlmDisabledError contract this file leans on", () => {
  it("is the error the shared answerer actually catches", () => {
    // If the class were ever swapped for a plain Error, every assertion above
    // would still pass while production started returning a 500 instead of the
    // passages.
    expect(new LlmDisabledError("x")).toBeInstanceOf(Error);
    expect(new LlmDisabledError("x").name).toBe("LlmDisabledError");
  });
});
