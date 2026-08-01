import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { closePools, sql } from "../db.js";
import { EMBEDDING_DIMS } from "../embed.js";
import { LlmDisabledError } from "../llm.js";
import type { McpContext } from "./tools.js";
import { askDocs } from "./tools.js";

/**
 * What `ask_docs` retrieves from a real corpus, and what it refuses to retrieve
 * from someone else's.
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

describe("the LlmDisabledError contract this file leans on", () => {
  it("is the error the shared answerer actually catches", () => {
    // If the class were ever swapped for a plain Error, every assertion above
    // would still pass while production started returning a 500 instead of the
    // passages.
    expect(new LlmDisabledError("x")).toBeInstanceOf(Error);
    expect(new LlmDisabledError("x").name).toBe("LlmDisabledError");
  });
});
