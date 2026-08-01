import { createHash } from "node:crypto";
import { gateDecisions } from "@sadhak/shared/schema";
import type { ChangeDescriptor, GateMode, VerdictResult } from "@sadhak/shared/types";
import { and, eq } from "drizzle-orm";
import { db } from "../db.js";
import { UserError } from "../errors.js";
import {
  getVerdict,
  renderUnmappedWarn,
  renderVerdict,
  UnresolvedTargetError,
} from "../sentinel/verdict.js";

/**
 * One engine, three doors. `decide()` is a **wrapper, not a second engine**:
 * it calls `renderVerdict()`, which already resolves, traverses, scores and
 * persists the complete audit row, then records only the *enforcement* facts
 * on top. No LLM anywhere in this function.
 *
 * Every mode must produce byte-identical verdicts for the same change, which
 * is only true because there is exactly one path to a verdict.
 */

export interface DecideOptions {
  orgId: number;
  mode: GateMode;
  dryRun: boolean;
  /** A human, an agent name, or "github:owner/repo#41". */
  actor: string | null;
  apiKeyId: number | null;
  idempotencyKey?: string | undefined;
}

export interface DecideOutcome {
  decisionId: number;
  verdictId: string;
  result: VerdictResult;
  replayed: boolean;
}

export function hashRequest(change: ChangeDescriptor, dryRun: boolean): string {
  // Key order is normalized so an equivalent request hashes equal regardless
  // of how the caller serialized it.
  const canonical = JSON.stringify(
    Object.fromEntries(Object.entries(change).sort(([a], [b]) => a.localeCompare(b))),
  );
  return createHash("sha256").update(`${canonical}:${dryRun}`).digest("hex");
}

export async function decide(
  change: ChangeDescriptor,
  opts: DecideOptions,
): Promise<DecideOutcome> {
  const requestHash = hashRequest(change, opts.dryRun);

  // Look the key up first: a replay costs one indexed read and no traversal.
  if (opts.idempotencyKey && opts.apiKeyId !== null) {
    const existing = await findByIdempotencyKey(
      opts.orgId,
      opts.apiKeyId,
      opts.idempotencyKey,
    );
    if (existing) {
      if (existing.requestHash !== requestHash) {
        throw new UserError(
          "This Idempotency-Key was already used with a different request body",
          { status: 422, type: "idempotency-mismatch" },
        );
      }
      const result = await getVerdict(opts.orgId, existing.verdictId);
      if (result) {
        return {
          decisionId: existing.id,
          verdictId: existing.verdictId,
          result,
          replayed: true,
        };
      }
    }
  }

  // An unmapped target is a deterministic WARN — never APPROVE (unmapped is
  // not safe) and never BLOCK (that would be a false block on a model of
  // nothing).
  let result: VerdictResult;
  try {
    result = await renderVerdict(opts.orgId, change, { createdBy: opts.actor });
  } catch (error) {
    if (!(error instanceof UnresolvedTargetError)) throw error;
    result = await renderUnmappedWarn(opts.orgId, change, opts.actor);
  }

  const [inserted] = await db
    .insert(gateDecisions)
    .values({
      orgId: opts.orgId,
      verdictId: result.id,
      mode: opts.mode,
      dryRun: opts.dryRun,
      actor: opts.actor,
      apiKeyId: opts.apiKeyId,
      idempotencyKey: opts.idempotencyKey ?? null,
      requestHash,
    })
    .onConflictDoNothing()
    .returning({ id: gateDecisions.id });

  if (inserted) {
    return {
      decisionId: inserted.id,
      verdictId: result.id,
      result,
      replayed: false,
    };
  }

  // A concurrent request won the race. Return its row and abandon ours: an
  // orphan `verdicts` row with no `gate_decisions` pointing at it was never an
  // enforcement event, so it cannot pollute any count.
  if (opts.idempotencyKey && opts.apiKeyId !== null) {
    const winner = await findByIdempotencyKey(
      opts.orgId,
      opts.apiKeyId,
      opts.idempotencyKey,
    );
    if (winner) {
      const winnerResult = await getVerdict(opts.orgId, winner.verdictId);
      if (winnerResult) {
        return {
          decisionId: winner.id,
          verdictId: winner.verdictId,
          result: winnerResult,
          replayed: true,
        };
      }
    }
  }

  throw new UserError("Could not record the decision", { status: 409, type: "conflict" });
}

async function findByIdempotencyKey(orgId: number, apiKeyId: number, key: string) {
  const [row] = await db
    .select({
      id: gateDecisions.id,
      verdictId: gateDecisions.verdictId,
      requestHash: gateDecisions.requestHash,
    })
    .from(gateDecisions)
    .where(
      and(
        eq(gateDecisions.orgId, orgId),
        eq(gateDecisions.apiKeyId, apiKeyId),
        eq(gateDecisions.idempotencyKey, key),
      ),
    )
    .limit(1);
  return row ?? null;
}
