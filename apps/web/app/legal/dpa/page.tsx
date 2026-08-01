import type { Metadata } from "next";
import { LegalPage } from "../../../components/legal-page";
import { EFFECTIVE, REVIEW_NOTICE, VERSION } from "../shared";

export const metadata: Metadata = {
  title: "Data processing agreement",
  description:
    "The DPA template, downloadable, plus a plain summary of what it commits us to.",
};

export default function DpaPage() {
  return (
    <LegalPage
      title="Data processing agreement"
      summary="If your organisation needs a DPA on file before connecting a system, this is it. The summary below is the honest version; the template is the one your legal team will want."
      effective={EFFECTIVE}
      version={VERSION}
      notice={REVIEW_NOTICE}
      sections={[
        {
          id: "download",
          title: "The template",
          body: (
            <>
              <p>
                Standard controller/processor terms, with the subprocessor annex, SCC
                hooks and the deletion and export commitments the product actually
                implements.
              </p>
              <p>
                <a
                  className="btn btn--primary"
                  href="/legal/DPA-template.txt"
                  download="Sadhak-DPA-template.txt"
                >
                  Download the DPA template
                </a>
              </p>
              <p>
                It is plain text rather than a PDF because it is meant to be redlined, and
                because the file you download is the same bytes that sit in the public
                repository — there is no second copy that could quietly differ.
              </p>
            </>
          ),
        },
        {
          id: "short",
          title: "The short version",
          body: (
            <>
              <p>
                Most DPAs are long because most processors touch a great deal of personal
                data. This one is short for a structural reason rather than a stylistic
                one.
              </p>
              <div className="legal__pledge">
                Sadhak stores{" "}
                <strong>the shape of your systems, not their contents</strong>. It records
                that a field called <code>invoices.vat_rate</code> exists and which report
                reads it. It never reads an invoice — enforced at the connector boundary,
                and verified by a test that plants canary strings inside cell values and
                fails the build if any of them reaches our database.
              </div>
              <p>
                So the personal data in scope is narrow: your users' account details, and
                the discussion excerpts mined from channels you explicitly select — a
                colleague's message explaining why something exists, with their name and a
                permalink.
              </p>
            </>
          ),
        },
        {
          id: "commitments",
          title: "What it commits us to",
          body: (
            <ul>
              <li>
                <strong>Processing only on your instructions.</strong> Connecting a
                connector and choosing a mining scope are the instructions.
              </li>
              <li>
                <strong>30 days' notice before a new subprocessor,</strong> with the right
                to object and leave without penalty.
              </li>
              <li>
                <strong>Breach notification within 72 hours</strong> of us becoming aware,
                with what is known then rather than waiting for a complete picture.
              </li>
              <li>
                <strong>Self-serve export and deletion,</strong> both live in the product
                today. Deletion cascades at the database with no grace period and no soft
                delete.
              </li>
              <li>
                <strong>Audit by reading the source,</strong> which is public, plus
                written answers to reasonable questions.
              </li>
            </ul>
          ),
        },
        {
          id: "where-data-lives",
          title: "Where the data lives",
          body: (
            <p>
              At rest, on a single virtual server in <strong>India</strong>. In transit,
              through Cloudflare. Mined discussion excerpts reach OpenRouter in the{" "}
              <strong>United States</strong> and onward to whichever provider serves the
              model. Nothing else leaves. Full detail, including what each one sees, is on{" "}
              <a href="/legal/subprocessors">Subprocessors</a>.
            </p>
          ),
        },
        {
          id: "signing",
          title: "Signing it",
          body: (
            <p>
              The processor signature block cannot be completed yet — the operating entity
              is not incorporated. That is stated in the template itself rather than left
              as a blank line, and it is the honest answer to &ldquo;can you countersign
              this?&rdquo; during beta. If a signed DPA is a hard requirement for you,
              tell us and we will not pretend the constraint away.
            </p>
          ),
        },
      ]}
      footnote={
        <p>
          Redlines and objections are welcome as a{" "}
          <a href="https://github.com/ashtonmths/Sarvam/issues">GitHub issue</a> or by
          email, whichever your process prefers.
        </p>
      }
    />
  );
}
