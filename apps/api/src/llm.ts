/**
 * The only module in the codebase that talks to a model provider.
 *
 * Retries, timeouts, rate limiting and model selection live here so that
 * swapping OpenRouter for a direct provider — or moving from free to paid
 * models — touches one file and zero call sites. Nothing on the verdict path
 * imports this: a slow, failed, disabled or quota-exhausted call costs prose,
 * never a gate.
 *
 * Model configuration (verified against OpenRouter's live model list on
 * 2026-07-22 — 342 models, 14 with a `:free` suffix, 13 supporting tools, only
 * 4 supporting structured outputs):
 *
 *   strong  nvidia/nemotron-3-super-120b-a12b:free   262k, tools + structured
 *   bulk    google/gemma-4-26b-a4b-it:free           262k, tools + structured
 *
 * Fallback chain when a slug is retired or a provider 404s:
 *   openai/gpt-oss-20b:free  →  nvidia/nemotron-nano-9b-v2:free
 * Largest free context if ever needed: nvidia/nemotron-3-ultra-550b-a55b:free
 * (1M context, tools, but *no* structured outputs — the loop would fall back
 * to its strict-JSON text protocol on it).
 *
 * Free-tier quotas are hard product constraints, not footnotes: 20
 * requests/minute **account-wide** — not per model, not per process, not per
 * loop — and 50 requests/day, rising to 1000/day after a one-time $10 credit.
 */

import { config, requireEnv } from "./config.js";

const ENDPOINT = "https://openrouter.ai/api/v1/chat/completions";

export type Role = "system" | "user" | "assistant" | "tool";

export interface Message {
  role: Role;
  content: string;
  tool_call_id?: string;
  tool_calls?: ToolCall[];
}

export interface ToolCall {
  id: string;
  type: "function";
  function: { name: string; arguments: string };
}

export interface ToolDef {
  type: "function";
  function: {
    name: string;
    description: string;
    parameters: Record<string, unknown>;
  };
}

export type Tier = "strong" | "bulk";

/* --------------------------------------------------------------- errors */

/** The kill switch tripped. No fetch is attempted. */
export class LlmDisabledError extends Error {
  constructor(reason = "LLM calls are disabled") {
    super(reason);
    this.name = "LlmDisabledError";
  }
}

/**
 * The daily cap is spent. Terminal, not retryable: no wait inside a request
 * lifetime clears it, so retrying only burns the retry budget and the wall
 * clock before failing anyway.
 */
export class LlmQuotaExhaustedError extends Error {
  constructor(
    readonly resetAt: string | null,
    message = "daily model quota exhausted",
  ) {
    super(message);
    this.name = "LlmQuotaExhaustedError";
  }
}

/* ----------------------------------------------------------- rate limit */

/**
 * One module-level bucket, awaited by every caller. The free-tier ceiling is
 * account-wide, so a per-loop limiter is correct exactly once and wrong the
 * instant a second investigation loop, the explainer and a webhook run
 * concurrently — n loops each politely holding to 20 rpm produce 20n rpm at
 * the account. This placement is also the only one a new caller cannot bypass.
 */
class RequestBucket {
  #timestamps: number[] = [];

  constructor(
    private readonly limit: number,
    private readonly windowMs = 60_000,
  ) {}

  async acquire(): Promise<void> {
    for (;;) {
      const now = Date.now();
      this.#timestamps = this.#timestamps.filter((t) => now - t < this.windowMs);
      if (this.#timestamps.length < this.limit) {
        this.#timestamps.push(now);
        return;
      }
      const oldest = this.#timestamps[0] ?? now;
      await sleep(Math.max(10, this.windowMs - (now - oldest)));
    }
  }

  /** For tests and the fan-out concurrency derivation. */
  get inWindow(): number {
    const now = Date.now();
    return this.#timestamps.filter((t) => now - t < this.windowMs).length;
  }
}

const bucket = new RequestBucket(config.LLM_RPM_LIMIT);

export function requestsInCurrentWindow(): number {
  return bucket.inWindow;
}

/* ------------------------------------------------------------- policy */

type PolicyCheck = (orgId: number | null) => Promise<boolean>;
let orgPolicy: PolicyCheck = async () => true;

/** Wired by `llm-policy.ts` so this module keeps zero Drizzle imports. */
export function setOrgPolicy(check: PolicyCheck): void {
  orgPolicy = check;
}

async function assertEnabled(orgId: number | null): Promise<void> {
  if (config.LLM_DISABLED) throw new LlmDisabledError("LLM_DISABLED is set");
  if (!(await orgPolicy(orgId))) {
    throw new LlmDisabledError("LLM calls are disabled for this organization");
  }
}

/* ----------------------------------------------------------- accounting */

export interface Usage {
  promptTokens: number;
  completionTokens: number;
  costUsd: number;
}

export interface CompleteOptions {
  tier?: Tier;
  messages: Message[];
  tools?: ToolDef[];
  toolChoice?: "auto" | "required";
  responseFormat?: Record<string, unknown>;
  timeoutMs?: number;
  maxRetries?: number;
  /** Mandatory: which subsystem is spending, e.g. "sentinel.explain". */
  caller: string;
  orgId?: number | null;
  signal?: AbortSignal;
}

export interface Completion {
  content: string | null;
  toolCalls: ToolCall[];
  usage: Usage;
  model: string;
}

function modelFor(tier: Tier): string {
  // Missing model config fails the prose, never the boot: the deterministic
  // verdict path uses no model at all.
  return requireEnv(
    tier === "strong" ? "OPENROUTER_MODEL_STRONG" : "OPENROUTER_MODEL_BULK",
  );
}

interface ChatBody {
  choices?: Array<{
    message?: { content?: string | null; tool_calls?: ToolCall[] };
  }>;
  usage?: { prompt_tokens?: number; completion_tokens?: number; cost?: number };
}

function buildBody(opts: CompleteOptions, stream: boolean): string {
  return JSON.stringify({
    model: modelFor(opts.tier ?? "strong"),
    messages: opts.messages,
    ...(opts.tools?.length
      ? { tools: opts.tools, tool_choice: opts.toolChoice ?? "auto" }
      : {}),
    ...(opts.responseFormat ? { response_format: opts.responseFormat } : {}),
    ...(stream ? { stream: true } : {}),
    usage: { include: true },
  });
}

/**
 * Disambiguates the two 429s. A per-minute throttle is retryable and the
 * caller never sees it; daily exhaustion is not, and fails fast so the caller
 * can report *when* service returns instead of just failing.
 */
async function classify429(res: Response): Promise<Error> {
  const body = await res.text().catch(() => "");
  const reset =
    res.headers.get("x-ratelimit-reset") ?? res.headers.get("ratelimit-reset") ?? null;

  const daily = /per[- ]?day|daily|free-models-per-day|quota/i.test(body);
  if (daily) {
    const resetAt = reset ? new Date(Number(reset) * 1000).toISOString() : null;
    return new LlmQuotaExhaustedError(resetAt);
  }
  return new Error(`openrouter 429 (throttled)`);
}

function logCall(fields: Record<string, unknown>): void {
  // Token counts and costs only — never prompt bodies. Plan 15 lifts these
  // into metrics; the shape is stable from here.
  console.log(JSON.stringify({ event: "llm_call", ...fields }));
}

export async function complete(opts: CompleteOptions): Promise<Completion> {
  const { tier = "strong", timeoutMs = 60_000, maxRetries = 2, caller } = opts;
  await assertEnabled(opts.orgId ?? null);

  const key = requireEnv("OPENROUTER_API_KEY");
  const model = modelFor(tier);
  const started = Date.now();
  let lastError: unknown;

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    await bucket.acquire();
    const timeout = AbortSignal.timeout(timeoutMs);
    const signal = opts.signal ? AbortSignal.any([timeout, opts.signal]) : timeout;

    try {
      const res = await fetch(ENDPOINT, {
        method: "POST",
        signal,
        headers: {
          Authorization: `Bearer ${key}`,
          "Content-Type": "application/json",
          "X-Title": "Sadhak",
        },
        body: buildBody(opts, false),
      });

      if (res.status === 429) {
        const error = await classify429(res);
        // Terminal: zero retries, no backoff sleep.
        if (error instanceof LlmQuotaExhaustedError) {
          logCall({
            tier,
            model,
            caller,
            orgId: opts.orgId ?? null,
            ok: false,
            reason: "quota",
          });
          throw error;
        }
        lastError = error;
        await sleep(2 ** attempt * 500);
        continue;
      }

      if (res.status >= 500) {
        lastError = new Error(`openrouter ${res.status}`);
        await sleep(2 ** attempt * 500);
        continue;
      }
      if (!res.ok) throw new Error(`openrouter ${res.status}: ${await res.text()}`);

      const body = (await res.json()) as ChatBody;
      const message = body.choices?.[0]?.message;
      const usage: Usage = {
        promptTokens: body.usage?.prompt_tokens ?? 0,
        completionTokens: body.usage?.completion_tokens ?? 0,
        costUsd: body.usage?.cost ?? 0,
      };

      logCall({
        tier,
        model,
        caller,
        orgId: opts.orgId ?? null,
        ...usage,
        latencyMs: Date.now() - started,
        ok: true,
      });

      return {
        content: message?.content ?? null,
        toolCalls: message?.tool_calls ?? [],
        usage,
        model,
      };
    } catch (err) {
      if (err instanceof LlmQuotaExhaustedError || err instanceof LlmDisabledError)
        throw err;
      lastError = err;
      if (attempt === maxRetries) break;
      await sleep(2 ** attempt * 500);
    }
  }

  logCall({ tier, model, caller, orgId: opts.orgId ?? null, ok: false });
  throw lastError instanceof Error ? lastError : new Error(String(lastError));
}

/**
 * Streaming completion. Yields content deltas; the final usage block is
 * requested even when streaming so accounting stays honest.
 */
export async function* completeStream(
  opts: CompleteOptions,
): AsyncGenerator<string, Usage, void> {
  const { tier = "strong", timeoutMs = 60_000, caller } = opts;
  await assertEnabled(opts.orgId ?? null);

  const key = requireEnv("OPENROUTER_API_KEY");
  const model = modelFor(tier);
  const started = Date.now();

  await bucket.acquire();
  const timeout = AbortSignal.timeout(timeoutMs);
  const signal = opts.signal ? AbortSignal.any([timeout, opts.signal]) : timeout;

  const res = await fetch(ENDPOINT, {
    method: "POST",
    signal,
    headers: {
      Authorization: `Bearer ${key}`,
      "Content-Type": "application/json",
      "X-Title": "Sadhak",
      Accept: "text/event-stream",
    },
    body: buildBody(opts, true),
  });

  if (res.status === 429) throw await classify429(res);
  if (!res.ok) throw new Error(`openrouter ${res.status}: ${await res.text()}`);
  if (!res.body) throw new Error("openrouter returned no stream body");

  const usage: Usage = { promptTokens: 0, completionTokens: 0, costUsd: 0 };
  const decoder = new TextDecoder();
  const reader = res.body.getReader();
  let buffer = "";

  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      // `stream: true` keeps a multi-byte character split across chunks intact.
      buffer += decoder.decode(value, { stream: true });

      const lines = buffer.split("\n");
      buffer = lines.pop() ?? "";

      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed.startsWith("data:")) continue;
        const payload = trimmed.slice(5).trim();
        if (payload === "[DONE]") continue;

        try {
          const chunk = JSON.parse(payload) as {
            choices?: Array<{ delta?: { content?: string } }>;
            usage?: { prompt_tokens?: number; completion_tokens?: number; cost?: number };
          };
          const delta = chunk.choices?.[0]?.delta?.content;
          if (delta) yield delta;
          if (chunk.usage) {
            usage.promptTokens = chunk.usage.prompt_tokens ?? usage.promptTokens;
            usage.completionTokens =
              chunk.usage.completion_tokens ?? usage.completionTokens;
            usage.costUsd = chunk.usage.cost ?? usage.costUsd;
          }
        } catch {
          /* a partial JSON line resolves on the next chunk */
        }
      }
    }
  } finally {
    reader.releaseLock();
    logCall({
      tier,
      model,
      caller,
      orgId: opts.orgId ?? null,
      ...usage,
      latencyMs: Date.now() - started,
      ok: true,
      streamed: true,
    });
  }

  return usage;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
