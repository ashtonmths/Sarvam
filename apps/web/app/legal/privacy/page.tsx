import type { Metadata } from "next";
import { LegalPage } from "../../../components/legal-page";
import { EFFECTIVE, REVIEW_NOTICE, VERSION } from "../shared";

export const metadata: Metadata = {
  title: "Privacy",
  description:
    "What Sadhak stores, what it refuses to store, and where each commitment is enforced in the code.",
};

/**
 * Every commitment here names the mechanism that enforces it.
 *
 * A privacy policy that says "we take security seriously" is unfalsifiable and
 * therefore worthless to the person reading it before a security review. These
 * claims were written by reading the enforcement site first, so each one can be
 * checked against the repository — and if the code changes, the claim breaks
 * visibly rather than quietly becoming untrue.
 */

export default function PrivacyPage() {
  return (
    <LegalPage
      title="Privacy"
      summary="Sadhak maps how your systems depend on each other. Doing that well requires knowing your schema and your reasoning — not your records. This page is precise about the difference."
      effective={EFFECTIVE}
      version={VERSION}
      notice={REVIEW_NOTICE}
      sections={[
        {
          id: "principle",
          title: "The one commitment everything else follows from",
          body: (
            <>
              <div className="legal__pledge">
                <strong>Structure, never payloads.</strong> Sadhak records that a field
                called <code>invoices.vat_rate</code> exists, that a VAT report reads it,
                and that someone explained why in a Slack thread. It does not record a
                single invoice.
              </div>
              <p>
                This is not a policy preference layered on afterwards; it is where the
                connectors stop. Each crawler emits schema and wiring — table names,
                column names, types, references, workflow steps — and there is no code
                path that selects row data into the graph. A crawl of a
                hundred-million-row table and a crawl of an empty one produce the same
                size of record.
              </p>
            </>
          ),
        },
        {
          id: "what-we-store",
          title: "What Sadhak stores",
          body: (
            <>
              <ul>
                <li>
                  <strong>Graph structure.</strong> Nodes (tables, fields, workflows,
                  reports, APIs) and edges between them, each carrying how it was
                  discovered and how much that method is trusted.
                </li>
                <li>
                  <strong>Rationale.</strong> Quoted spans of text explaining why a
                  dependency exists, each with a permalink back to the source. The quoted
                  span only — never the full channel archive, never a message that was not
                  matched.
                </li>
                <li>
                  <strong>Verdicts and decisions.</strong> What was proposed, what Sadhak
                  answered, what evidence it cited, and what the human did next.
                </li>
                <li>
                  <strong>Account data.</strong> Name, email, hashed password, org
                  membership, and an audit log of who did what.
                </li>
                <li>
                  <strong>Connector credentials,</strong> encrypted at rest. See below.
                </li>
              </ul>
            </>
          ),
        },
        {
          id: "credentials",
          title: "Credentials",
          body: (
            <>
              <p>
                Credentials are sealed with authenticated encryption before they reach the
                database, and the additional authenticated data binds each one to its
                organisation, connector instance, scope and kind. A sealed credential
                lifted into another org's row does not decrypt — it fails as tampering
                rather than opening.
              </p>
              <p>
                Read and write are <strong>separate credentials</strong>. Crawling asks
                for a read-only credential and cannot be given a writing one by accident,
                because they are different rows with different scopes. A write credential
                exists only if you set one up for reverts, and it is the only path by
                which Sadhak can change anything in your systems.
              </p>
              <p>
                We ask you to supply the narrowest credential the connector can work with,
                and the connector documentation states the minimum. Nothing here prevents
                you from handing over an admin token; a great deal here means you do not
                need to.
              </p>
            </>
          ),
        },
        {
          id: "llm",
          title: "What is sent to a language model",
          body: (
            <>
              <p>
                Stated plainly because it is the question that matters most, and the one a
                vague answer would flatter us on.
              </p>
              <p>
                When you enable mining for specific Slack channels, the Historian searches{" "}
                <strong>those channels only</strong> and puts matching message snippets in
                front of a language model so it can propose an explanation and cite a
                permalink. Those snippets are your colleagues' words, and they leave our
                server. They go to OpenRouter, which routes them onward to the model
                provider. See <a href="/legal/subprocessors">Subprocessors</a>.
              </p>
              <p>
                Nothing else does. Your rows never do. Your credentials never do. Semantic
                search over rationale uses a model that runs on our own server, so that
                text is not shipped to an embedding API.
              </p>
              <div className="legal__pledge">
                <strong>No model decides anything.</strong> A verdict is a deterministic
                function of the graph — the same change against the same graph returns the
                same answer, every time, with no model in the path. An edge that a model
                inferred is capped: it can raise a warning, and it can never block.
              </div>
            </>
          ),
        },
        {
          id: "retention",
          title: "Retention and deletion",
          body: (
            <>
              <p>
                Deleting an organisation deletes its graph, rationale, verdicts,
                decisions, credentials and audit log, by database-level cascade rather
                than by a cleanup job that might not run. Deletion is immediate and not
                recoverable by us.
              </p>
              <p>
                Disconnecting a single connector removes its credentials and marks the
                nodes it discovered as stale rather than deleting them, so verdicts
                already issued still make sense when you read them later. You can delete
                them outright from the connector settings.
              </p>
            </>
          ),
        },
        {
          id: "rights",
          title: "Your rights",
          body: (
            <p>
              You can export your graph and your decision history at any time through the
              API, and delete your organisation from settings without contacting us. For
              access, correction, or any request under GDPR or the DPDP Act, write to us
              and we will answer within 30 days. During beta these requests are handled by
              a person, not a workflow.
            </p>
          ),
        },
        {
          id: "cookies",
          title: "Cookies and tracking",
          body: (
            <p>
              One cookie: an opaque session token, set when you sign in, marked{" "}
              <code>HttpOnly</code> and <code>SameSite</code>. No analytics, no
              advertising pixels, no session recording, and no third-party JavaScript on
              any page. There is no cookie banner because there is nothing to consent to.
            </p>
          ),
        },
      ]}
      footnote={
        <p>
          Every claim on this page describes code you can read:{" "}
          <a href="https://github.com/ashtonmths/Sarvam">the repository is public</a>. If
          a claim and the code disagree, the code is the truth and the claim is a bug.
        </p>
      }
    />
  );
}
