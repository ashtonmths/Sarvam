"use client";

import { useState } from "react";
import { API_URL } from "../../lib/env";

/**
 * How an agent connects to the proxy gate.
 *
 * This is the differentiated half of the product — everyone is shipping agents
 * that act, and this is the thing that tells them no — and until now the only
 * way to learn the endpoint was to read the docs site. An API key with no
 * address to send it to is a key nobody uses.
 *
 * The key is never rendered here. It is shown exactly once, when it is created,
 * and the snippet carries a placeholder so copying this block can never leak a
 * live credential into a screenshot or a pasted issue.
 */

const TOOLS = [
  {
    name: "propose_change",
    what: "Ask permission before mutating something. Returns APPROVE, WARN or BLOCK with the evidence behind it.",
  },
  {
    name: "query_blast_radius",
    what: "What breaks if this changes, without proposing anything.",
  },
  { name: "get_node", what: "One node, its criticality and its confirmed rationale." },
];

export function McpConnect() {
  const [copied, setCopied] = useState<string | null>(null);
  const endpoint = `${API_URL}/mcp`;

  const claudeCode = `claude mcp add --transport http sadhak ${endpoint} \\
  --header "Authorization: Bearer sk_live_your_key_here"`;

  const jsonConfig = `{
  "mcpServers": {
    "sadhak": {
      "type": "http",
      "url": "${endpoint}",
      "headers": {
        "Authorization": "Bearer sk_live_your_key_here"
      }
    }
  }
}`;

  async function copy(label: string, text: string) {
    await navigator.clipboard.writeText(text);
    setCopied(label);
    setTimeout(() => setCopied(null), 2000);
  }

  return (
    <section className="panel">
      <h2 className="panel__title">Connect an agent</h2>
      <p className="panel__caption">
        The proxy gate. An agent asks before it changes anything, and a BLOCK means the
        change is never forwarded — refusal happens here, not in the agent's own
        judgement.
      </p>

      <div className="mcp">
        <div className="mcp__endpoint">
          <span className="mcp__label">Endpoint</span>
          <code className="mono">{endpoint}</code>
          <button
            type="button"
            className="btn btn--ghost btn--tiny"
            onClick={() => void copy("endpoint", endpoint)}
          >
            {copied === "endpoint" ? "Copied" : "Copy"}
          </button>
        </div>

        <div className="mcp__block">
          <div className="mcp__block-head">
            <span className="mcp__label">Claude Code</span>
            <button
              type="button"
              className="btn btn--ghost btn--tiny"
              onClick={() => void copy("cli", claudeCode)}
            >
              {copied === "cli" ? "Copied" : "Copy"}
            </button>
          </div>
          <pre className="mcp__pre">{claudeCode}</pre>
        </div>

        <div className="mcp__block">
          <div className="mcp__block-head">
            <span className="mcp__label">Claude Desktop, Cursor and anything else</span>
            <button
              type="button"
              className="btn btn--ghost btn--tiny"
              onClick={() => void copy("json", jsonConfig)}
            >
              {copied === "json" ? "Copied" : "Copy"}
            </button>
          </div>
          <pre className="mcp__pre">{jsonConfig}</pre>
        </div>

        <ul className="mcp__tools">
          {TOOLS.map((tool) => (
            <li key={tool.name}>
              <code className="mono">{tool.name}</code>
              <span>{tool.what}</span>
            </li>
          ))}
        </ul>

        <p className="mcp__note">
          Swap the placeholder for a key created above. The key scopes every query to this
          organisation, so an agent cannot read another tenant's graph, and the verdict it
          gets back is the same arithmetic the merge gate uses.
        </p>
      </div>
    </section>
  );
}
