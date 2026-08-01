import { llmRequests, llmUsage } from "@sadhak/shared/schema";
import { and, eq, sql } from "drizzle-orm";
import { config } from "../config.js";
import { db } from "../db.js";
import type { Usage } from "../llm.js";

/**
 * An agent fleet without a meter is a pager incident shaped like an invoice.
 *
 * While free models are in use the dollar figure is 0.0000 and the **request
 * count is the only budget that can actually stop anything** — the machinery
 * is exactly as designed, it just meters a different unit, and it meters both
 * so the paid path needs no new code.
 */

export type Agent = "historian" | "explainer" | "reviewer";

function firstOfMonth(): string {
  const now = new Date();
  return `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, "0")}-01`;
}

function today(): string {
  return new Date().toISOString().slice(0, 10);
}

/**
 * One OpenRouter key serves every org, so remaining-today is an **account**
 * number: the cap minus the sum across all orgs. A per-org budget inside a
 * shared ceiling is an allocation, not a guarantee, and pretending otherwise
 * is how one tenant silently breaks every other tenant's demo.
 */
export async function requestsRemainingToday(): Promise<number> {
  const [row] = await db
    .select({ used: sql<number>`COALESCE(SUM(${llmRequests.requests}), 0)::int` })
    .from(llmRequests)
    .where(eq(llmRequests.day, today()));

  return Math.max(0, config.LLM_DAILY_REQUEST_CAP - (row?.used ?? 0));
}

async function orgRequestsToday(orgId: number): Promise<number> {
  const [row] = await db
    .select({ used: sql<number>`COALESCE(SUM(${llmRequests.requests}), 0)::int` })
    .from(llmRequests)
    .where(and(eq(llmRequests.day, today()), eq(llmRequests.orgId, orgId)));
  return row?.used ?? 0;
}

async function orgSpendThisMonth(orgId: number): Promise<number> {
  const [row] = await db
    .select({ spend: sql<string>`COALESCE(SUM(${llmUsage.costUsd}), 0)` })
    .from(llmUsage)
    .where(and(eq(llmUsage.orgId, orgId), eq(llmUsage.month, firstOfMonth())));
  return Number(row?.spend ?? 0);
}

export interface OrgBudget {
  hasHeadroom(): Promise<boolean>;
  record(usage: Usage): Promise<void>;
  requestsRemainingToday(): Promise<number>;
}

export function orgBudget(orgId: number, agent: Agent, tier = "strong"): OrgBudget {
  return {
    async hasHeadroom() {
      // Either limit stops the loop. The dollar one is inert on free models;
      // the request one is what actually bites.
      const [spend, orgRequests, accountRemaining] = await Promise.all([
        orgSpendThisMonth(orgId),
        orgRequestsToday(orgId),
        requestsRemainingToday(),
      ]);

      if (spend >= config.HISTORIAN_ORG_BUDGET_USD) return false;
      if (orgRequests >= config.HISTORIAN_ORG_DAILY_REQUESTS) return false;
      if (accountRemaining <= 0) return false;
      return true;
    },

    async record(usage: Usage) {
      await db
        .insert(llmUsage)
        .values({
          orgId,
          month: firstOfMonth(),
          agent,
          tier,
          requests: 1,
          promptTokens: usage.promptTokens,
          completionTokens: usage.completionTokens,
          costUsd: String(usage.costUsd),
        })
        .onConflictDoUpdate({
          target: [llmUsage.orgId, llmUsage.month, llmUsage.agent, llmUsage.tier],
          set: {
            requests: sql`${llmUsage.requests} + 1`,
            promptTokens: sql`${llmUsage.promptTokens} + ${usage.promptTokens}`,
            completionTokens: sql`${llmUsage.completionTokens} + ${usage.completionTokens}`,
            costUsd: sql`${llmUsage.costUsd} + ${String(usage.costUsd)}`,
          },
        });

      // Always +1, including repair turns and failed parses: a malformed model
      // is a model burning quota, and the ledger must feel it.
      await db
        .insert(llmRequests)
        .values({ day: today(), orgId, agent, requests: 1 })
        .onConflictDoUpdate({
          target: [llmRequests.day, llmRequests.orgId, llmRequests.agent],
          set: { requests: sql`${llmRequests.requests} + 1` },
        });
    },

    requestsRemainingToday,
  };
}

/**
 * Concurrency is **derived from the rate limit, not asserted**. One loop
 * issues at most 60/p50 requests per minute, so the bucket admits
 * LLM_RPM_LIMIT ÷ that many loops before extra ones merely queue inside
 * `llm.ts` — zero extra throughput, wider blast radius on cancel.
 */
export function derivedConcurrency(p50LoopCallSeconds = 15): number {
  const perLoopRpm = 60 / Math.max(1, p50LoopCallSeconds);
  const derived = Math.floor(config.LLM_RPM_LIMIT / perLoopRpm);
  return Math.max(1, Math.min(derived, config.HISTORIAN_FANOUT_CONCURRENCY_MAX));
}
