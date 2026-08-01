import type { Metadata } from "next";
import { LegalPage } from "../../../components/legal-page";
import { EFFECTIVE, REVIEW_NOTICE, VERSION } from "../shared";

export const metadata: Metadata = {
  title: "Subprocessors",
  description:
    "Every third party that touches Sadhak data, what it is for, and what it sees. Including the ones we do not use.",
};

/**
 * This list is audited against the running system, not against intent.
 *
 * Every row here was confirmed from the repository or the live deployment
 * before it was written down: the compose file for what runs, `whois` on the
 * deployed address for where it runs, and the LLM call sites for what leaves
 * the machine. The plan that specified this page listed Stripe, Sentry and
 * Resend — none of the three exist in this build, and listing a subprocessor
 * that does not process anything is the same kind of lie as omitting one that
 * does.
 */

const SUBPROCESSORS = [
  {
    name: "Hostinger International",
    purpose: "Virtual private server. Runs the API, the web app, Postgres and n8n.",
    data: "All of it. Your graph, rationale, credentials (encrypted) and audit log live on this machine.",
    location: "India",
  },
  {
    name: "Cloudflare",
    purpose: "DNS, TLS termination and reverse proxy for sadhak.online.",
    data: "Everything in transit passes through it, decrypted at the edge. Request metadata and bodies.",
    location: "Global anycast",
  },
  {
    name: "OpenRouter",
    purpose:
      "LLM inference for the Historian and the drafting of rationale. Never for a verdict.",
    data: "Graph structure, and quoted spans of discussion text from the channels you select for mining.",
    location: "United States; routes onward to the model provider serving the request",
  },
  {
    name: "GitHub",
    purpose: "Source hosting and the container registry the deployment pulls from.",
    data: "No customer data. Images and source only.",
    location: "United States",
  },
];

const NOT_USED = [
  ["Any embedding vendor", "Embeddings run locally on the server, via bge-small-en."],
  ["Stripe or any payment processor", "Nothing is charged. There is no billing code."],
  ["Sentry or any error tracker", "Stack traces stay in the container log."],
  ["Resend, SendGrid or any email provider", "No mailer exists in this build."],
  [
    "Any analytics or session-recording script",
    "The web app loads no third-party JavaScript.",
  ],
];

export default function SubprocessorsPage() {
  return (
    <LegalPage
      title="Subprocessors"
      summary="Every third party that touches Sadhak data, what it is for, and what it sees. The list below was checked against the running system, not against a template."
      effective={EFFECTIVE}
      version={VERSION}
      notice={REVIEW_NOTICE}
      sections={[
        {
          id: "current",
          title: "Current subprocessors",
          body: (
            <>
              <div className="legal__table-wrap">
                <table className="legal__table">
                  <thead>
                    <tr>
                      <th>Subprocessor</th>
                      <th>Purpose</th>
                      <th>Data it sees</th>
                      <th>Location</th>
                    </tr>
                  </thead>
                  <tbody>
                    {SUBPROCESSORS.map((row) => (
                      <tr key={row.name}>
                        <td>
                          <strong>{row.name}</strong>
                        </td>
                        <td>{row.purpose}</td>
                        <td>{row.data}</td>
                        <td>{row.location}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              <p>
                Your connected systems — Slack, GitHub, Airtable, n8n, your Postgres — are
                not subprocessors. Data moves <em>from</em> them <em>to</em> us, at your
                direction, using credentials you supply. We do not send your data to them,
                with one exception: a revert writes back to the system the change was made
                in, which is the entire point of a revert.
              </p>
            </>
          ),
        },
        {
          id: "openrouter",
          title: "What actually reaches the model",
          body: (
            <>
              <p>
                This is the disclosure worth reading twice, because it is the one where a
                vague answer would be convenient for us.
              </p>
              <p>
                The Historian searches the Slack channels{" "}
                <strong>you explicitly select for mining</strong> and puts the matching
                message snippets in front of a language model, so it can propose why a
                dependency exists and cite a permalink. Those snippets are your people
                talking. They go to OpenRouter, which routes them to whichever provider
                serves the model.
              </p>
              <div className="legal__pledge">
                <strong>What never reaches a model:</strong> the contents of your database
                rows, records, or files. Sadhak indexes that{" "}
                <code>invoices.vat_rate</code> exists and who reads it. It never reads an
                invoice. This is enforced at the connector boundary, where crawlers emit
                schema and wiring only.
              </div>
              <p>
                Two further limits. Mining is scoped: a channel that is not selected is
                never searched. And no model output can produce a verdict — the gate is a
                deterministic function of the graph, and an edge a model inferred is
                capped so it can warn but never block.
              </p>
            </>
          ),
        },
        {
          id: "not-used",
          title: "What we do not use",
          body: (
            <>
              <p>
                Listed because their absence is a commitment, and because several are
                assumed to be present in any SaaS of this shape.
              </p>
              <div className="legal__table-wrap">
                <table className="legal__table">
                  <thead>
                    <tr>
                      <th>Not used</th>
                      <th>Instead</th>
                    </tr>
                  </thead>
                  <tbody>
                    {NOT_USED.map(([name, why]) => (
                      <tr key={name}>
                        <td>
                          <strong>{name}</strong>
                        </td>
                        <td>{why}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              <p>
                Local embeddings are the one worth calling out. Semantic search over your
                rationale normally means shipping every sentence to an embedding API.
                Sadhak runs the model on its own server, so that text never leaves for
                that purpose.
              </p>
            </>
          ),
        },
        {
          id: "changes",
          title: "Changes to this list",
          body: (
            <p>
              Adding a subprocessor is a change to this page and a notice to every
              organisation with a connected system, at least 30 days before it starts
              processing. If you object, the remedy is to disconnect the affected
              connector or close the account and have the data deleted; there is no
              penalty for either.
            </p>
          ),
        },
      ]}
      footnote={
        <p>
          Something on this page that does not match what you observe is a bug, and we
          would rather hear about it than not:{" "}
          <a href="https://github.com/ashtonmths/Sarvam/issues">open an issue</a>.
        </p>
      }
    />
  );
}
