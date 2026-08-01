import type { Metadata } from "next";
import { LegalPage } from "../../../components/legal-page";
import { EFFECTIVE, VERSION } from "../shared";

export const metadata: Metadata = {
  title: "Legal change history",
  description:
    "Every version of the terms, privacy policy, DPA and subprocessor list, with what changed.",
};

/**
 * The version history, kept by hand.
 *
 * Deliberately not generated from git. A legal changelog answers "did the
 * commitment change, and when did it start binding me" — which is a smaller and
 * different set of events than every commit that touched the file, and burying
 * it in typo fixes would defeat the point.
 */

interface Entry {
  version: string;
  date: string;
  pages: string;
  changes: string[];
}

const HISTORY: Entry[] = [
  {
    version: "1.0",
    date: EFFECTIVE,
    pages: "Terms, Privacy, DPA, Subprocessors",
    changes: [
      "First publication.",
      "Subprocessor list audited against the running deployment rather than drafted from the plan: Stripe, Sentry and an email provider were all specified for this page and none of them exist in the build, so none are listed. Cloudflare was found by resolving the deployed domain and added.",
      "Every privacy commitment written against the enforcement site in the code, so each one can be checked rather than taken on trust.",
    ],
  },
];

export default function ChangelogPage() {
  return (
    <LegalPage
      title="Legal change history"
      summary="What changed, when it took effect, and which pages it touched. Substantive changes are announced at least 30 days before they bind you."
      effective={EFFECTIVE}
      version={VERSION}
      sections={[
        {
          id: "history",
          title: "Versions",
          body: (
            <>
              {HISTORY.map((entry) => (
                <div key={entry.version} style={{ marginBottom: 28 }}>
                  <p>
                    <strong>
                      Version {entry.version} — {entry.date}
                    </strong>
                    <br />
                    <span style={{ fontSize: "0.9rem" }}>{entry.pages}</span>
                  </p>
                  <ul>
                    {entry.changes.map((change) => (
                      <li key={change}>{change}</li>
                    ))}
                  </ul>
                </div>
              ))}
            </>
          ),
        },
        {
          id: "how",
          title: "How changes are made",
          body: (
            <>
              <p>
                A change that alters your obligations, our commitments, or who processes
                your data is announced by email to every organisation with a connected
                system, at least <strong>30 days</strong> before it takes effect. The
                previous version stays on this page.
              </p>
              <p>
                A change that does not — a typo, a clarified sentence, a broken link —
                takes effect when published and is still logged here. We would rather
                over-record than have you wonder whether a page moved under you.
              </p>
              <p>
                Because these pages live in a public repository, there is also a complete
                commit history for anyone who wants the diff rather than the summary.
              </p>
            </>
          ),
        },
      ]}
    />
  );
}
