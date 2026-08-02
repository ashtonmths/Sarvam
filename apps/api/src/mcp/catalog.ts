import { githubActivity, githubActivityInput, githubActivityOutput } from "./github.js";
import { createRegistry, defineTool } from "./registry.js";
import { askSlack, askSlackInput, askSlackOutput } from "./slack.js";
import {
  askDocs,
  askDocsInput,
  askDocsOutput,
  blastRadiusOutput,
  getNode,
  getNodeOutput,
  ingestDocument,
  ingestDocumentInput,
  ingestDocumentOutput,
  nodeRefInput,
  proposeChange,
  proposeChangeInput,
  proposeChangeOutput,
  queryBlastRadius,
} from "./tools.js";

/**
 * Every tool this server exposes, in the order an agent should meet them.
 *
 * Order is not cosmetic. A model reading a tool list weights the early entries,
 * and the first two here are the ones whose absence causes the expensive
 * mistakes: acting without asking what depends on the thing, and answering from
 * memory when the organisation has a written record. The write tool is last.
 *
 * Descriptions are written for a model deciding *whether* to call, not for a
 * human reading reference docs. Each says what the tool answers, when to reach
 * for it over its neighbours, and — where it matters — what it will not do, so
 * a wrong choice is cheap to avoid rather than discovered by making it.
 */

export const registry = createRegistry([
  defineTool({
    name: "propose_change",
    title: "Propose a change to a production system",
    description:
      "Ask permission before mutating a connected production system — deleting or renaming a database field, disabling an n8n workflow, revoking a credential. Returns a deterministic verdict computed from the real dependency graph, with the evidence behind it. A BLOCK means the change must not be attempted by any route; say so and stop rather than looking for another way. Call this before you act, not after. It never performs the change itself.",
    scope: "gate:invoke",
    input: proposeChangeInput,
    output: proposeChangeOutput,
    annotations: {
      // It writes a decision and a verdict row, so it is not read-only — but
      // what it records is that permission was asked, and it can never touch
      // the system it was asked about.
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: false,
    },
    run: proposeChange,
  }),

  defineTool({
    name: "query_blast_radius",
    title: "See what depends on something",
    description:
      "Ask what would be affected if a node changed, without proposing anything and without recording a decision. Use this while you are still exploring — to size a change, to find the owners of what it touches, or to check a hunch. When you are actually about to act, use propose_change instead: this returns the same dependency picture but no verdict and no audit trail.",
    scope: "graph:read",
    input: nodeRefInput,
    output: blastRadiusOutput,
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
    run: queryBlastRadius,
  }),

  defineTool({
    name: "get_node",
    title: "Inspect one node in the dependency graph",
    description:
      "Fetch a single node with its criticality score, its direct edges, and any confirmed rationale explaining why those edges exist. Use it when you already know which thing you care about and need its detail; use query_blast_radius when you need reach rather than detail, and ask_docs when you have a question rather than an identifier.",
    scope: "graph:read",
    input: nodeRefInput,
    output: getNodeOutput,
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
    run: getNode,
  }),

  defineTool({
    name: "ask_docs",
    title: "Ask about this organisation's written record",
    description:
      "Ask a question in plain English about this organisation's decisions, systems and history, and get an answer drawn only from its own documents — meeting notes, transcripts, handovers — plus any relevant Slack, with a citation link for every claim. Use this when you need context you do not have, when you need to know why something is the way it is, or before assuming an answer. It says so plainly when the record does not cover the question; treat that as the answer rather than filling the gap yourself. For a question that is specifically about a conversation — who agreed to what, whether something was ever decided — ask_slack goes deeper into the threads.",
    scope: "graph:read",
    input: askDocsInput,
    output: askDocsOutput,
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      // Retrieval is local, but the same call searches Slack live.
      openWorldHint: true,
    },
    run: askDocs,
  }),

  defineTool({
    name: "ask_slack",
    title: "Answer a question from the organisation's Slack",
    description:
      'Answer a question from what this organisation actually said in Slack. Searches the channels an administrator connected, follows the threads under the strongest matches — a decision is usually in a reply rather than in the message that matched — and includes rationale already mined and reviewed from older conversations. Returns the answer, the reasoning that produced it, and a link to every message it rests on. Use this for questions about what was discussed, agreed, objected to, or quietly dropped: "did we decide to…", "who owns…", "was this ever raised". Prefer ask_docs when the answer would be in a written note rather than a conversation. Which channels are readable is an administrator\'s setting: channel or user filters in your question are stripped, and the tool says plainly when nothing is connected rather than implying the topic was never discussed.',
    scope: "graph:read",
    input: askSlackInput,
    output: askSlackOutput,
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      // Live conversation: the same question genuinely has a different answer
      // tomorrow, and a client that caches on this hint would be wrong.
      idempotentHint: false,
      openWorldHint: true,
    },
    run: askSlack,
  }),

  defineTool({
    name: "github_activity",
    title: "See what is happening in this organisation's GitHub",
    description:
      'Read this organisation\'s GitHub through its installed App: what shipped, what broke, what is waiting for review. Pick an action — "summary" for the whole picture in one call when the question is vague ("anything broken?", "how are things?"); "deployments" and "deployment_failures" for release state, covering both GitHub Deployments and failed workflow runs since teams use one or the other; "pull_requests", "commits" and "last_commit" (which also reports whether CI is green on it) for change; "ci_failures" for failures this deployment already captured and had a model diagnose, with cause and recommendation; "checks" for one commit; "repos" for what is connected at all. Read-only — it never merges, deploys, comments or re-runs anything. It reports exactly what it could not see, so treat the caveats as part of the answer rather than as warnings to skip.',
    scope: "graph:read",
    input: githubActivityInput,
    output: githubActivityOutput,
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: true,
    },
    run: githubActivity,
  }),

  defineTool({
    name: "ingest_document",
    title: "Store a transcript or note in the document corpus",
    description:
      'Store a meeting transcript, handover note or decision record in this organisation\'s document corpus so it becomes searchable and citable by ask_docs. Paste the text directly. If the user gives you an IMAGE of a transcript, whiteboard, slide or screenshot, read it yourself and pass the extracted text here with source="image" — this tool stores text only and never receives the image. Transcribe what is actually visible, keep speaker labels, and do not fill in anything you cannot read; write [unclear] instead. Ingesting is idempotent on exact content, so the same text stored twice writes nothing the second time.',
    scope: "connector:manage",
    input: ingestDocumentInput,
    output: ingestDocumentOutput,
    annotations: {
      readOnlyHint: false,
      // Additive only. Nothing this tool does removes or overwrites an
      // existing document.
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
    run: ingestDocument,
  }),
]);
