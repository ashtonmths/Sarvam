/**
 * The only module in the codebase that talks to a model provider.
 *
 * Retries, timeouts and model selection live here so that swapping OpenRouter
 * for a direct provider later touches one file. Nothing on the verdict path
 * imports this: a slow or failed call costs prose, never a gate.
 */

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

function modelFor(tier: Tier): string {
  const model =
    tier === "strong"
      ? process.env.OPENROUTER_MODEL_STRONG
      : process.env.OPENROUTER_MODEL_BULK;
  if (!model) throw new Error(`OPENROUTER_MODEL_${tier.toUpperCase()} is not set`);
  return model;
}

export interface CompleteOptions {
  tier?: Tier;
  messages: Message[];
  tools?: ToolDef[];
  timeoutMs?: number;
  maxRetries?: number;
}

export interface Completion {
  content: string | null;
  toolCalls: ToolCall[];
}

export async function complete(opts: CompleteOptions): Promise<Completion> {
  const {
    tier = "strong",
    messages,
    tools,
    timeoutMs = 60_000,
    maxRetries = 2,
  } = opts;

  const key = process.env.OPENROUTER_API_KEY;
  if (!key) throw new Error("OPENROUTER_API_KEY is not set");

  let lastError: unknown;
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    const abort = AbortSignal.timeout(timeoutMs);
    try {
      const res = await fetch(ENDPOINT, {
        method: "POST",
        signal: abort,
        headers: {
          Authorization: `Bearer ${key}`,
          "Content-Type": "application/json",
          "X-Title": "Sadhak",
        },
        body: JSON.stringify({
          model: modelFor(tier),
          messages,
          ...(tools?.length ? { tools, tool_choice: "auto" } : {}),
        }),
      });

      if (res.status === 429 || res.status >= 500) {
        lastError = new Error(`openrouter ${res.status}`);
        await sleep(2 ** attempt * 500);
        continue;
      }
      if (!res.ok) throw new Error(`openrouter ${res.status}: ${await res.text()}`);

      const body = (await res.json()) as {
        choices?: { message?: { content?: string | null; tool_calls?: ToolCall[] } }[];
      };
      const message = body.choices?.[0]?.message;
      return {
        content: message?.content ?? null,
        toolCalls: message?.tool_calls ?? [],
      };
    } catch (err) {
      lastError = err;
      if (attempt === maxRetries) break;
      await sleep(2 ** attempt * 500);
    }
  }
  throw lastError instanceof Error ? lastError : new Error(String(lastError));
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
