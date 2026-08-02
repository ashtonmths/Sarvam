import { connectorInstances, miningScopes } from "@sadhak/shared/schema";
import { and, eq } from "drizzle-orm";
import { config } from "../../config.js";
import { db } from "../../db.js";
import { embed, embedAll } from "../../embed.js";
import { getCredential } from "../../vault/vault.js";

/**
 * Slack mining. Two honest paths, because `search.messages` requires a **user**
 * token with `search:read` — bot tokens cannot call it.
 *
 * Either way, the channel list comes from `mining_scopes` server-side. A
 * model-supplied channel qualifier is never honored, so no tool argument can
 * widen what Historian may read.
 *
 * Retrieval is three steps, and skipping any of them returns an empty result on
 * a workspace that plainly contains the answer:
 *
 *  1. **Turn the question into terms.** Slack search ANDs the words it is
 *     given, so a question — "did we ever agree to drop the nightly
 *     reconciliation job?" — asks Slack for a single message containing all
 *     eleven of those words, and there is no such message. `ci/analyse.ts`
 *     already learned this and hand-built keywords for its own Slack lookups;
 *     this module now does the same for everybody.
 *  2. **Scope by channel id, ourselves.** The mining scope stores channel ids,
 *     and Slack's `in:` modifier resolves channel *names* — `in:C0932ABCD` is
 *     not a filter to Slack, it is one more word the message has to contain.
 *     So the qualifier is built from resolved names where they are known, and
 *     the scope is enforced afterwards against the id on every match, which is
 *     the check that actually holds.
 *  3. **Rank by meaning.** Terms recall broadly and rank badly. The local
 *     embedding model that already serves document retrieval reorders the
 *     candidates against the original question, so the message that answers it
 *     comes back ahead of the one that merely shares a word with it.
 */

/**
 * Field names are snake_case because this object is serialised straight to the
 * model, and `authored_at` is the argument name `propose_rationale` expects
 * back. Making them match is what stops the model reformatting a timestamp.
 */
export interface SlackHit {
  text: string;
  author: string;
  ts: string;
  authored_at: string | null;
  permalink: string;
}

/**
 * Slack's `ts` is "<epoch seconds>.<microseconds>" and doubles as a message id.
 * Only the seconds half is a time; the rest disambiguates messages within the
 * same second. Parsed by splitting rather than with parseFloat so the original
 * string is never round-tripped through a float — that is what silently
 * corrupts it when it is used as an id.
 */
export function tsToIso(ts: string): string | null {
  const seconds = Number(ts.split(".")[0]);
  if (!Number.isFinite(seconds) || seconds <= 0) return null;
  return new Date(seconds * 1000).toISOString();
}

/**
 * Overridable so the agent evals can serve planted evidence from a local
 * fixture server. Goes through `config` rather than being read here, because
 * the lint rule that confines `process.env` to one module is what makes the
 * env schema trustworthy, and a seam worth having is a seam worth documenting.
 */
const SLACK_API = config.SLACK_API_BASE_URL;

/** What a caller gets back. More is retrieved, then ranked down to this. */
export const MAX_HITS = 10;

/** Slack's own ceiling for `search.messages`. Asking for less only loses recall. */
const SEARCH_COUNT = 100;

/**
 * Below this many in-scope hits, the qualified search is retried without its
 * channel qualifier and filtered here instead.
 *
 * The qualifier is worth attempting first — it keeps messages from channels
 * nobody consented to mine out of this process altogether — but Slack's parser
 * is not something this code can assert against, and a query that returns
 * nothing because a modifier was read as a search term is indistinguishable
 * from a workspace that never discussed the subject. The retry is what makes
 * those two distinguishable.
 */
const MIN_QUALIFIED_HITS = 3;

/** Enough to rank meaningfully; short of embedding a channel dump per question. */
const CANDIDATE_CAP = 120;

async function slackToken(
  orgId: number,
  kind: "oauth_user_access" | "oauth_access",
): Promise<string | null> {
  const [instance] = await db
    .select({ id: connectorInstances.id })
    .from(connectorInstances)
    .where(
      and(eq(connectorInstances.orgId, orgId), eq(connectorInstances.connector, "slack")),
    )
    .limit(1);
  if (!instance) return null;

  const secret = await getCredential(orgId, instance.id, "read", kind, "historian.slack");
  return secret?.reveal() ?? null;
}

async function scopedChannels(orgId: number): Promise<string[]> {
  const rows = await db
    .select({ value: miningScopes.scopeValue })
    .from(miningScopes)
    .where(and(eq(miningScopes.orgId, orgId), eq(miningScopes.connector, "slack")));
  return rows.map((r) => r.value);
}

/* ------------------------------------------------------------------ *
 * Question -> search terms
 * ------------------------------------------------------------------ */

/**
 * Words that carry no signal in a workspace search.
 *
 * Deliberately conservative. Every word dropped here is a word Slack will not
 * match on, so the list holds grammar and question scaffolding only — nothing
 * that could name a system, an action or a state. "deploy", "incident",
 * "failed", "owner" and "billing" are all the substance of a real question and
 * none of them are in it.
 */
const STOPWORDS = new Set([
  "a",
  "about",
  "after",
  "again",
  "against",
  "all",
  "already",
  "also",
  "am",
  "an",
  "and",
  "any",
  "anybody",
  "anyone",
  "anything",
  "are",
  "around",
  "as",
  "at",
  "be",
  "because",
  "been",
  "before",
  "being",
  "below",
  "between",
  "both",
  "but",
  "by",
  "can",
  "could",
  "did",
  "do",
  "does",
  "doing",
  "done",
  "down",
  "during",
  "each",
  "either",
  "else",
  "ever",
  "every",
  "everybody",
  "everyone",
  "few",
  "for",
  "from",
  "further",
  "get",
  "gets",
  "got",
  "had",
  "has",
  "have",
  "having",
  "he",
  "her",
  "here",
  "hers",
  "him",
  "his",
  "how",
  "however",
  "i",
  "if",
  "in",
  "into",
  "is",
  "it",
  "its",
  "itself",
  "just",
  "let",
  "like",
  "many",
  "may",
  "maybe",
  "me",
  "might",
  "more",
  "most",
  "much",
  "must",
  "my",
  "need",
  "needs",
  "no",
  "nobody",
  "nor",
  "not",
  "nothing",
  "now",
  "of",
  "off",
  "on",
  "once",
  "one",
  "only",
  "or",
  "other",
  "others",
  "our",
  "ours",
  "out",
  "over",
  "own",
  "please",
  "really",
  "same",
  "say",
  "said",
  "says",
  "she",
  "should",
  "since",
  "so",
  "some",
  "somebody",
  "someone",
  "something",
  "still",
  "such",
  "than",
  "that",
  "the",
  "their",
  "theirs",
  "them",
  "then",
  "there",
  "these",
  "they",
  "thing",
  "things",
  "this",
  "those",
  "though",
  "through",
  "to",
  "too",
  "under",
  "until",
  "up",
  "us",
  "use",
  "used",
  "very",
  "was",
  "way",
  "we",
  "were",
  "what",
  "whatever",
  "when",
  "where",
  "whether",
  "which",
  "while",
  "who",
  "whom",
  "whose",
  "why",
  "will",
  "with",
  "would",
  "yes",
  "yet",
  "you",
  "your",
  "yours",
]);

/**
 * How many terms reach Slack.
 *
 * Every extra term widens an OR query, and past a point the tail is words like
 * "job" that match half the workspace and push the message that matters out of
 * the hundred rows Slack returns. Eight covers a question with two subjects and
 * a qualifier.
 */
const MAX_TERMS = 8;

/**
 * The words worth searching for, longest first.
 *
 * Length stands in for specificity, which is crude and right often enough:
 * "reconciliation" identifies a conversation and "job" does not. Short tokens
 * survive only when they are obviously an identifier — `n8n`, `v2`, `pg16` —
 * because a two-character word that contains a digit was chosen by somebody,
 * and a two-character word that does not is grammar.
 */
export function contentTerms(question: string): string[] {
  const words = stripQualifiers(question)
    .toLowerCase()
    .split(/[^a-z0-9_./-]+/)
    // Trailing punctuation survives the split when it is inside the class —
    // "deploy." and "deploy" must not be two terms.
    .map((word) => word.replace(/^[._/-]+|[._/-]+$/g, ""))
    .filter(Boolean);

  const kept: string[] = [];
  for (const word of words) {
    if (STOPWORDS.has(word)) continue;
    const identifierish = /[0-9_./-]/.test(word);
    if (word.length < 3 && !identifierish) continue;
    if (!kept.includes(word)) kept.push(word);
  }

  return [...kept].sort((a, b) => b.length - a.length).slice(0, MAX_TERMS);
}

/**
 * The query string Slack is actually given.
 *
 * `OR` rather than juxtaposition, because juxtaposition is AND and a question's
 * words never co-occur in one message. Recall is the job here; the ranking that
 * follows is what turns recall into an answer.
 *
 * A question that reduces to nothing — "why is this?" — falls back to its own
 * words, which finds nothing and is honest about it rather than searching for
 * the empty string and returning the channel's last hundred messages.
 */
export function buildSearchQuery(question: string): string {
  const terms = contentTerms(question);
  if (terms.length === 0) return stripQualifiers(question);
  return terms.join(" OR ");
}

/** Distinct terms present, so a message matching three beats one matching one. */
export function lexicalScore(text: string, terms: string[]): number {
  const lower = text.toLowerCase();
  return terms.reduce((score, term) => (lower.includes(term) ? score + 1 : score), 0);
}

/* ------------------------------------------------------------------ *
 * Ranking
 * ------------------------------------------------------------------ */

/** Both operands come from the same unit-normalised model, so this is cosine. */
function dot(a: number[], b: number[]): number {
  let total = 0;
  for (let i = 0; i < a.length && i < b.length; i += 1) {
    total += (a[i] ?? 0) * (b[i] ?? 0);
  }
  return total;
}

/**
 * Reorders candidates by what they mean rather than which words they share.
 *
 * This is the step that makes "did the invoice import break last week?" find a
 * message reading "the OCR job died on the 12th" — a lexical search cannot,
 * because the two sentences have no word in common. The model is the same local
 * one that ranks documents, so this adds no vendor and no key.
 *
 * Failure is not fatal on purpose. If the model cannot load — a cold cache, a
 * read-only volume, the exact failure `embed.ts` documents at length — the
 * caller still gets the lexically-ranked list rather than an error, which is
 * the difference between a slightly worse answer and no answer.
 */
export async function rankByMeaning<T extends { text: string }>(
  question: string,
  candidates: T[],
  limit: number,
): Promise<T[]> {
  if (candidates.length <= 1) return candidates.slice(0, limit);

  try {
    const [target, vectors] = await Promise.all([
      embed(question),
      embedAll(candidates.map((candidate) => candidate.text)),
    ]);

    return candidates
      .map((candidate, i) => ({ candidate, score: dot(target, vectors[i] ?? []) }))
      .sort((a, b) => b.score - a.score)
      .slice(0, limit)
      .map((row) => row.candidate);
  } catch {
    return candidates.slice(0, limit);
  }
}

/* ------------------------------------------------------------------ *
 * Channel identity
 * ------------------------------------------------------------------ */

/**
 * Channel ids to names, for the one thing names are needed for: Slack's `in:`
 * modifier, which does not accept an id.
 *
 * Cached per org because a workspace's channel list does not change between two
 * questions asked a minute apart, and `conversations.list` pages — on a large
 * workspace it is the most expensive call in this file. Best effort throughout:
 * every consumer treats an empty map as "no qualifier available" and carries on
 * with the id filter, which is the check that enforces the scope anyway.
 */
const DIRECTORY_TTL_MS = 10 * 60_000;
const directoryCache = new Map<number, { at: number; byId: Map<string, string> }>();

/** Exported for tests, which must not inherit another case's workspace. */
export function clearChannelDirectory(): void {
  directoryCache.clear();
}

async function channelDirectory(
  orgId: number,
  botToken: string,
  signal?: AbortSignal,
): Promise<Map<string, string>> {
  const cached = directoryCache.get(orgId);
  if (cached && Date.now() - cached.at < DIRECTORY_TTL_MS) return cached.byId;

  const byId = new Map<string, string>();
  try {
    let cursor: string | undefined;
    for (let page = 0; page < 20; page += 1) {
      const params = new URLSearchParams({
        limit: "200",
        exclude_archived: "true",
        types: "public_channel,private_channel",
      });
      if (cursor) params.set("cursor", cursor);

      const res = await fetch(`${SLACK_API}/conversations.list?${params.toString()}`, {
        headers: { authorization: `Bearer ${botToken}` },
        ...(signal ? { signal } : {}),
      });
      if (!res.ok) break;

      const body = (await res.json()) as {
        ok?: boolean;
        channels?: Array<{ id?: string; name?: string }>;
        response_metadata?: { next_cursor?: string };
      };
      if (!body.ok) break;

      for (const channel of body.channels ?? []) {
        if (channel.id && channel.name) byId.set(channel.id, channel.name);
      }

      cursor = body.response_metadata?.next_cursor || undefined;
      if (!cursor) break;
    }
  } catch {
    // A directory that will not load costs the qualifier and nothing else.
  }

  directoryCache.set(orgId, { at: Date.now(), byId });
  return byId;
}

/**
 * Whether a match belongs to a channel this org chose to mine.
 *
 * Both the id and the name are checked because the scope column holds whatever
 * the caller that wrote it had. The connector picker writes ids, the demo
 * seeder writes id-shaped constants, and an org that had scopes inserted by
 * hand may well hold names — a name in that column silently mining nothing is
 * a worse outcome than a slightly looser comparison.
 */
function inScope(
  scopes: Set<string>,
  channelId: string | undefined,
  channelName: string | undefined,
): boolean {
  if (channelId && scopes.has(channelId)) return true;
  if (channelName && scopes.has(channelName)) return true;
  return Boolean(channelName && scopes.has(`#${channelName}`));
}

/* ------------------------------------------------------------------ *
 * Search
 * ------------------------------------------------------------------ */

/**
 * A search that could not run is not a search that found nothing.
 *
 * Returning a bare empty array conflated the two, and the agent cannot tell
 * them apart: it concludes there is no written trace, calls give_up, and the
 * edge is recorded as investigated-and-unexplainable — having spent the run's
 * budget without ever reaching Slack. `unavailable` carries the reason so the
 * model is told it was blocked rather than left to infer an absence.
 */
export interface SearchResult {
  hits: SlackHit[];
  unavailable?: string;
  /**
   * How many channels were in scope for this search. Zero is the one case a
   * caller must phrase differently: "nothing matched" and "nothing was looked
   * at" are opposite facts, and for a long time both arrived as `hits: []`.
   */
  channelsSearched: number;
  /** Which path produced the hits, for the caveats a caller prints. */
  via?: "search" | "scan";
}

/**
 * All this search needs of a caller. `LoopCtx` satisfies it structurally, so
 * Historian is unchanged — but /ask can search Slack too without inventing an
 * `edgeId` and two tracking maps that mean nothing outside the loop.
 */
export interface SlackSearchCtx {
  orgId: number;
  signal?: AbortSignal | undefined;
}

export const NO_CHANNELS_SELECTED =
  "No Slack channel has been selected for mining, so there was nothing to search. An admin picks channels in connector settings.";

export async function searchSlack(
  ctx: SlackSearchCtx,
  query: string,
): Promise<SearchResult> {
  const channels = await scopedChannels(ctx.orgId);
  if (channels.length === 0) {
    return { hits: [], channelsSearched: 0, unavailable: NO_CHANNELS_SELECTED };
  }

  const [userToken, botToken] = await Promise.all([
    slackToken(ctx.orgId, "oauth_user_access"),
    slackToken(ctx.orgId, "oauth_access"),
  ]);

  if (!userToken && !botToken) {
    return {
      hits: [],
      channelsSearched: channels.length,
      unavailable:
        "Slack is connected but no usable token is stored, so it could not be searched.",
    };
  }

  let refusal: string | undefined;

  if (userToken) {
    const directory = botToken
      ? await channelDirectory(ctx.orgId, botToken, ctx.signal)
      : new Map<string, string>();

    const searched = await searchViaApi(
      userToken,
      query,
      channels,
      directory,
      ctx.signal,
    );
    if (searched.hits.length > 0) {
      return { ...searched, channelsSearched: channels.length, via: "search" };
    }
    refusal = searched.unavailable;
  }

  /**
   * The scan is a fallback now, not only the bot-token path.
   *
   * `search.messages` is Slack's index, and an index answers for what it has
   * chosen to keep: it excludes some message subtypes, it lags, and on a free
   * workspace it does not reach past the retention window at all. Reading the
   * channels directly is slower and sees exactly what is there, so an empty
   * search is worth one — the alternative is telling somebody their workspace
   * never discussed a thing that is sitting in it.
   */
  if (!botToken) {
    return {
      hits: [],
      channelsSearched: channels.length,
      via: "search",
      ...(refusal ? { unavailable: refusal } : {}),
    };
  }

  const scanned = await scanChannels(botToken, query, channels, ctx.signal);
  // The search's own refusal survives a scan that merely found nothing: "the
  // token lost search:read" is the actionable half of that answer.
  const unavailable = scanned.unavailable ?? refusal;
  return {
    hits: scanned.hits,
    channelsSearched: channels.length,
    via: "scan",
    ...(unavailable ? { unavailable } : {}),
  };
}

interface SearchMatch {
  text?: string;
  username?: string;
  user?: string;
  ts?: string;
  permalink?: string;
  channel?: { id?: string; name?: string };
}

async function runSearch(
  token: string,
  query: string,
  signal?: AbortSignal,
): Promise<{ matches: SearchMatch[] } | { unavailable: string }> {
  const url = `${SLACK_API}/search.messages?query=${encodeURIComponent(query)}&count=${SEARCH_COUNT}`;

  const res = await fetch(url, {
    headers: { authorization: `Bearer ${token}` },
    ...(signal ? { signal } : {}),
  });
  if (!res.ok) return { unavailable: `Slack search returned HTTP ${res.status}.` };

  const body = (await res.json()) as {
    ok?: boolean;
    error?: string;
    messages?: { matches?: SearchMatch[] };
  };
  if (!body.ok) {
    // Slack answers 200 with ok:false, so a missing scope or a revoked token
    // arrives looking exactly like a successful empty search.
    return { unavailable: `Slack refused the search: ${body.error ?? "unknown"}.` };
  }

  return { matches: body.messages?.matches ?? [] };
}

/**
 * Preferred path. Two queries at most, and the scope is enforced on the results
 * either way.
 *
 * The first carries `in:#name` for every scoped channel whose name is known, so
 * Slack narrows before anything crosses the wire. The second drops the
 * qualifier entirely and lets this function do the filtering, which is what
 * runs when the names are unknown, when the workspace has more channels than
 * fit in a query, or when the qualified attempt came back thin because Slack
 * read the modifier in a way this code cannot see.
 */
export async function searchViaApi(
  token: string,
  question: string,
  channels: string[],
  directory: Map<string, string> = new Map(),
  signal?: AbortSignal,
): Promise<{ hits: SlackHit[]; unavailable?: string }> {
  const scopes = new Set(channels);
  const terms = contentTerms(question);
  const base = buildSearchQuery(question);

  const names = channels
    .map((channel) => directory.get(channel))
    .filter((name): name is string => Boolean(name));

  const attempts = names.length > 0 ? [withChannels(base, names), base] : [base];

  let refusal: string | undefined;
  let best: SlackHit[] = [];

  for (const attempt of attempts) {
    const outcome = await runSearch(token, attempt, signal);
    if ("unavailable" in outcome) {
      refusal = outcome.unavailable;
      continue;
    }

    const hits = outcome.matches
      .filter((match) => match.permalink && match.text)
      .filter((match) => inScope(scopes, match.channel?.id, match.channel?.name))
      .map((match) => ({
        text: (match.text ?? "").slice(0, 500),
        author: match.username ?? match.user ?? "unknown",
        ts: match.ts ?? "",
        authored_at: match.ts ? tsToIso(match.ts) : null,
        permalink: match.permalink as string,
      }));

    if (hits.length > best.length) best = hits;
    // Enough in-scope material to rank; a second query would only add noise.
    if (best.length >= MIN_QUALIFIED_HITS) break;
  }

  if (best.length === 0) {
    return refusal ? { hits: [], unavailable: refusal } : { hits: [] };
  }

  const ranked = await rankByMeaning(
    question,
    // Ties broken lexically before ranking, so that if the embedding model is
    // unavailable the truncation still keeps the strongest matches.
    [...best]
      .sort((a, b) => lexicalScore(b.text, terms) - lexicalScore(a.text, terms))
      .slice(0, CANDIDATE_CAP),
    MAX_HITS,
  );

  return { hits: ranked };
}

/**
 * Parenthesised so the OR binds to the terms rather than to the qualifier.
 *
 * `a OR b in:#ops` is ambiguous and Slack is entitled to read it as
 * `a OR (b in:#ops)`, which quietly searches the whole workspace for `a`. The
 * grouping states the intent; the id filter on the results is what guarantees
 * it regardless of how the intent was read.
 */
function withChannels(query: string, names: string[]): string {
  return `(${query}) ${names.map((name) => `in:#${name}`).join(" ")}`;
}

/**
 * Fallback for bot-token-only orgs, and for a search that came back empty:
 * bounded scan, ranked in memory.
 *
 * Every channel is read before anything is ranked. Returning at the first ten
 * matches, as this used to, meant the answer had to be in whichever channel the
 * scope query happened to list first — the last ten channels were never reached
 * on a workspace with more than a few, and nothing said so.
 */
export async function scanChannels(
  token: string,
  question: string,
  channels: string[],
  signal?: AbortSignal,
): Promise<{ hits: SlackHit[]; unavailable?: string }> {
  const terms = contentTerms(question);
  if (terms.length === 0) return { hits: [] };

  interface Candidate {
    text: string;
    author: string;
    ts: string;
    channel: string;
    score: number;
  }
  const candidates: Candidate[] = [];

  // Counted so a scan where every channel refused is reported as blocked
  // rather than as an honest empty result.
  let unreachable = 0;
  let lastError = "unknown";
  const perChannel = Math.max(
    1,
    Math.floor(config.SLACK_SCAN_MESSAGES / channels.length),
  );

  for (const channel of channels) {
    const url = `${SLACK_API}/conversations.history?channel=${encodeURIComponent(channel)}&limit=${Math.min(perChannel, 200)}`;
    const res = await fetch(url, {
      headers: { authorization: `Bearer ${token}` },
      ...(signal ? { signal } : {}),
    });
    if (!res.ok) {
      unreachable += 1;
      continue;
    }

    const body = (await res.json()) as {
      ok?: boolean;
      error?: string;
      messages?: Array<{ text?: string; user?: string; ts?: string }>;
    };
    if (!body.ok) {
      unreachable += 1;
      lastError = body.error ?? lastError;
      continue;
    }

    for (const message of body.messages ?? []) {
      const text = message.text ?? "";
      /**
       * At least one term, scored by how many.
       *
       * The old test was `terms.some(t => text.includes(t))` over every word in
       * the question, stopwords included — so "the" matched, and the scan
       * returned the ten most recent messages in the first channel dressed up
       * as search results. A model handed those answers confidently from
       * whatever they happened to say.
       */
      const score = lexicalScore(text, terms);
      if (score === 0) continue;

      candidates.push({
        text: text.slice(0, 500),
        author: message.user ?? "unknown",
        ts: message.ts ?? "",
        channel,
        score,
      });
    }
  }

  // Nothing from the scan persists except the final quoted span — pointers,
  // never archives.
  if (candidates.length === 0 && unreachable === channels.length) {
    return {
      hits: [],
      unavailable: `None of the ${channels.length} selected channels could be read (${lastError}). The bot may not be a member, or the token may have lost its scopes.`,
    };
  }

  const ranked = await rankByMeaning(
    question,
    [...candidates].sort((a, b) => b.score - a.score).slice(0, CANDIDATE_CAP),
    MAX_HITS,
  );

  /**
   * Permalinks last, and only for what survived ranking.
   *
   * `chat.getPermalink` is a request per message. Resolving one for every
   * lexical match — which is what happened when the filter ran inline — spent
   * a hundred calls against a rate limit to build a list that was then cut to
   * ten.
   */
  const hits: SlackHit[] = [];
  for (const candidate of ranked) {
    const permalink = await getPermalink(token, candidate.channel, candidate.ts, signal);
    if (!permalink) continue;
    hits.push({
      text: candidate.text,
      author: candidate.author,
      ts: candidate.ts,
      authored_at: candidate.ts ? tsToIso(candidate.ts) : null,
      permalink,
    });
  }

  if (hits.length === 0 && unreachable > 0) {
    return {
      hits: [],
      unavailable: `${unreachable} of the ${channels.length} selected channels could not be read (${lastError}). The bot may not be a member, or the token may have lost its scopes.`,
    };
  }

  return { hits };
}

async function getPermalink(
  token: string,
  channel: string,
  ts: string,
  signal?: AbortSignal,
): Promise<string | null> {
  if (!ts) return null;
  const res = await fetch(
    `${SLACK_API}/chat.getPermalink?channel=${encodeURIComponent(channel)}&message_ts=${encodeURIComponent(ts)}`,
    { headers: { authorization: `Bearer ${token}` }, ...(signal ? { signal } : {}) },
  );
  if (!res.ok) return null;
  const body = (await res.json()) as { ok?: boolean; permalink?: string };
  return body.ok ? (body.permalink ?? null) : null;
}

/**
 * Widened from `LoopCtx` to the same two fields `searchSlack` takes, for the
 * same reason: reading a thread needs an org and a cancellation signal, and
 * nothing else. Requiring the loop's `edgeId` and its two tracking maps meant
 * any other caller had to fabricate them, and `LoopCtx` still satisfies this
 * structurally so Historian is unaffected. It also removes the type import back
 * into `execute.ts`, which imports this module — a cycle that only held because
 * the signature was wider than the function.
 */
export async function readThread(
  ctx: SlackSearchCtx,
  permalink: string,
): Promise<{
  messages: Array<{
    text: string;
    author: string;
    authored_at: string | null;
    permalink: string;
  }>;
}> {
  const [userToken, botToken] = await Promise.all([
    slackToken(ctx.orgId, "oauth_user_access"),
    slackToken(ctx.orgId, "oauth_access"),
  ]);
  const token = userToken ?? botToken;
  if (!token) return { messages: [] };

  const match = /archives\/([A-Z0-9]+)\/p(\d+)/.exec(permalink);
  if (!match?.[1] || !match[2]) return { messages: [] };

  const channel = match[1];
  const raw = match[2];
  const messageTs = `${raw.slice(0, 10)}.${raw.slice(10)}`;

  /**
   * `conversations.replies` wants the *parent's* ts. A permalink to a reply
   * carries the reply's ts in the path and the parent's in `?thread_ts=`, so
   * using the path value returned just the one message the caller already had
   * — a silent no-op for exactly the threaded discussions this tool exists to
   * read, and the model would then give up for lack of context.
   */
  const threadTs = new URL(permalink).searchParams.get("thread_ts");
  const ts = threadTs ?? messageTs;

  /**
   * The permalink only carries an id, so a scope row holding a channel *name*
   * would fail this check and silently drop every thread. The directory is
   * consulted for exactly that case, and only when the id alone did not match.
   */
  const scopes = new Set(await scopedChannels(ctx.orgId));
  if (!scopes.has(channel)) {
    const name = botToken
      ? (await channelDirectory(ctx.orgId, botToken, ctx.signal)).get(channel)
      : undefined;
    if (!inScope(scopes, channel, name)) return { messages: [] };
  }

  const res = await fetch(
    `${SLACK_API}/conversations.replies?channel=${channel}&ts=${ts}&limit=50`,
    {
      headers: { authorization: `Bearer ${token}` },
      ...(ctx.signal ? { signal: ctx.signal } : {}),
    },
  );
  if (!res.ok) return { messages: [] };

  const body = (await res.json()) as {
    ok?: boolean;
    messages?: Array<{ text?: string; user?: string; ts?: string }>;
  };
  if (!body.ok) return { messages: [] };

  const messages = [];
  for (const message of body.messages ?? []) {
    const link = await getPermalink(token, channel, message.ts ?? "", ctx.signal);
    if (!link) continue;
    messages.push({
      text: (message.text ?? "").slice(0, 500),
      author: message.user ?? "unknown",
      authored_at: message.ts ? tsToIso(message.ts) : null,
      permalink: link,
    });
  }
  return { messages };
}

/** A model-supplied scope qualifier is stripped, never honored. */
export function stripQualifiers(query: string): string {
  return query.replace(/\b(in|from|channel):\S+/gi, "").trim();
}
