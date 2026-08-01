import type { Metadata } from "next";
import { LegalPage } from "../../../components/legal-page";
import { EFFECTIVE, REVIEW_NOTICE, VERSION } from "../shared";

export const metadata: Metadata = {
  title: "Terms",
  description:
    "The terms for using Sadhak during open beta. Short, because the product is free and the obligations are few.",
};

export default function TermsPage() {
  return (
    <LegalPage
      title="Terms of service"
      summary="Sadhak is in open beta and free to use. These terms are short because there is no money moving and no promise we are not in a position to keep."
      effective={EFFECTIVE}
      version={VERSION}
      notice={REVIEW_NOTICE}
      sections={[
        {
          id: "beta",
          title: "What beta means here",
          body: (
            <>
              <p>
                It means the software is being actively built, some of it has never run
                against a workload like yours, and we would rather you knew that than
                discovered it. Concretely:
              </p>
              <ul>
                <li>
                  <strong>Free.</strong> There is no billing code in the product. Nothing
                  can charge you because nothing is connected that could.
                </li>
                <li>
                  <strong>No uptime guarantee.</strong> Sadhak runs on a single server. We
                  publish our service level objectives, and they are objectives, not a
                  contractual commitment with credits attached.
                </li>
                <li>
                  <strong>Breaking changes happen,</strong> announced in advance where we
                  can and explained afterwards where we cannot.
                </li>
              </ul>
            </>
          ),
        },
        {
          id: "what-you-agree",
          title: "What you agree to",
          body: (
            <ul>
              <li>
                To connect only systems you are authorised to connect. A credential you
                were not given permission to use does not become acceptable by being
                pasted into our form.
              </li>
              <li>
                To supply the narrowest credential that works, and read-only credentials
                wherever the connector supports them.
              </li>
              <li>
                Not to attempt to reach other organisations' data, and to tell us if you
                find you can.
              </li>
              <li>
                Not to use Sadhak to build a competing product by extracting its outputs
                at scale. Reading the source is fine, and encouraged; it is public.
              </li>
            </ul>
          ),
        },
        {
          id: "gate",
          title: "What the gate does and does not promise",
          body: (
            <>
              <p>
                This section exists because the product's value proposition could be read
                as a guarantee, and it is not one.
              </p>
              <p>
                Sadhak blocks changes where a real enforcement point exists — a GitHub
                Check on a pull request, or a mutation routed through our API or MCP
                server. Where no such point exists, and for a browser tab deleting a field
                in a SaaS admin panel there is none, Sadhak detects the change after it
                happens and offers a revert.{" "}
                <strong>Detection and revert is not prevention</strong>, and we describe
                it that way everywhere including in the marketing.
              </p>
              <div className="legal__pledge">
                A verdict is only as good as the graph behind it. Sadhak reports what it
                has confirmed and shows what is still pending separately, precisely so an
                incomplete map does not read as a clean bill of health. A change Sadhak
                approves is a change with no known downstream impact — not a change that
                is certainly safe.
              </div>
              <p>
                You remain responsible for your systems. Sadhak is a decision aid with an
                audit trail, and it is not a substitute for your own review.
              </p>
            </>
          ),
        },
        {
          id: "your-data",
          title: "Your data stays yours",
          body: (
            <>
              <p>
                We claim no ownership of anything you connect, and no right to use your
                graph or your rationale to train models. See{" "}
                <a href="/legal/privacy">Privacy</a> for what is stored and{" "}
                <a href="/legal/subprocessors">Subprocessors</a> for what leaves our
                server.
              </p>
              <p>
                You can export everything as one file and delete your organisation
                outright, both from organisation settings, without asking us. Deletion
                cascades at the database and is not recoverable.
              </p>
            </>
          ),
        },
        {
          id: "liability",
          title: "Liability",
          body: (
            <p>
              Sadhak is provided as is, without warranty. To the maximum extent the law
              allows, we are not liable for indirect or consequential loss, and our total
              liability is limited to what you have paid us — which, during beta, is
              nothing. That is not a clever cap; it is the honest consequence of a free
              beta, and it is a reason to keep your own backups and your own review
              process while you evaluate.
            </p>
          ),
        },
        {
          id: "ending",
          title: "Ending it",
          body: (
            <p>
              You can stop at any time by deleting your organisation. We may suspend an
              account that is attacking the service or others' data, and we will say why.
              If we discontinue Sadhak we will give at least 30 days' notice and keep the
              export working for the whole of it.
            </p>
          ),
        },
        {
          id: "changes",
          title: "Changes to these terms",
          body: (
            <p>
              Substantive changes are announced at least 30 days before they take effect,
              with the previous version kept on the{" "}
              <a href="/legal/changelog">change history</a>. Continuing to use Sadhak
              after that is acceptance. Corrections that do not change your obligations —
              a typo, a clarified sentence — take effect when published and are still
              logged.
            </p>
          ),
        },
      ]}
      footnote={
        <p>
          Questions about any of this are welcome as a{" "}
          <a href="https://github.com/ashtonmths/Sarvam/issues">GitHub issue</a>,
          including the ones that are awkward for us to answer.
        </p>
      }
    />
  );
}
