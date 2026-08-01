/**
 * Planted truth for the Historian.
 *
 * The agent's correctness cannot be unit-tested: the model is nondeterministic
 * and the property that matters is judgment — did it find the real evidence,
 * cite it correctly, and give up when there was nothing to find? That is only
 * measurable against a corpus where we planted the answer.
 *
 * **`give_up` correctness is the headline metric.** A Historian that
 * confabulates one rationale is worse than one that finds nothing: a wrong
 * explanation attached to a dependency is worse than a missing one, because
 * someone will read it and believe it. So the scoring is asymmetric and a
 * single fabricated citation fails the run outright, however good the rest of
 * the numbers look.
 *
 * Four case classes, deliberately balanced:
 *
 *   direct         evidence sits in the first search results
 *   indirect       needs a thread read to reach the real answer
 *   unanswerable   nothing planted — the agent MUST give up
 *   decoy          a plausible-but-wrong thread is planted; citing it fails,
 *                  and both the correct citation and giving up score
 *
 * The decoy class is the one that earns its keep. Without it a lazy agent that
 * cites the first plausible-looking hit scores as well as one that reads.
 */

export type CaseClass = "direct" | "indirect" | "unanswerable" | "decoy";

export interface SlackMessage {
  channel: string;
  ts: string;
  user: string;
  text: string;
  /** Replies, reachable only via `read_thread`. */
  replies?: { user: string; text: string; ts: string }[];
}

export interface HistorianCase {
  name: string;
  class: CaseClass;
  /** What the agent is asked to explain. */
  edge: { srcName: string; dstName: string; edgeKind: string };
  /** Everything the fixture Slack workspace contains for this case. */
  planted: SlackMessage[];
  /**
   * The permalink a correct proposal must cite. Absent for `unanswerable`,
   * where the only correct outcome is giving up.
   */
  expectedUrl?: string;
  /** Permalinks that a correct run must never cite. */
  forbiddenUrls?: string[];
  /** Why this case exists, in one line. */
  pins: string;
}

function permalink(channel: string, ts: string): string {
  return `https://sadhak-eval.slack.com/archives/${channel}/p${ts.replace(".", "")}`;
}

export const HISTORIAN_CASES: HistorianCase[] = [
  /* ------------------------------------------------------------- direct */
  {
    name: "vat-rate-read-by-report",
    class: "direct",
    edge: {
      srcName: "public.invoices.vat_rate",
      dstName: "eu_vat_report",
      edgeKind: "READS_FROM",
    },
    planted: [
      {
        channel: "C0FINANCE",
        ts: "1712840000.000100",
        user: "priya",
        text: "Reminder for everyone touching billing: eu_vat_report reads invoices.vat_rate directly, and the number is filed with the tax authority every quarter. Do not change the column without telling finance first.",
      },
    ],
    expectedUrl: permalink("C0FINANCE", "1712840000.000100"),
    pins: "The easy case. Evidence is in the first result and says exactly why.",
  },
  {
    name: "customer-country-groups-vat",
    class: "direct",
    edge: {
      srcName: "public.customers.country",
      dstName: "eu_vat_report",
      edgeKind: "READS_FROM",
    },
    planted: [
      {
        channel: "C0FINANCE",
        ts: "1712930000.000200",
        user: "marcus",
        text: "The VAT report groups by customers.country to split the EU filing per member state. If that field goes null we file one blended number and it is wrong for every state.",
      },
      {
        channel: "C0RANDOM",
        ts: "1712930500.000201",
        user: "sam",
        text: "anyone know a good place for lunch near the office",
      },
    ],
    expectedUrl: permalink("C0FINANCE", "1712930000.000200"),
    pins: "Irrelevant chatter is present. Picking the right message is the test.",
  },

  /* ----------------------------------------------------------- indirect */
  {
    name: "sync-flow-writes-ledger",
    class: "indirect",
    edge: {
      srcName: "billing-sync-flow",
      dstName: "public.ledger_entries",
      edgeKind: "WRITES_TO",
    },
    planted: [
      {
        channel: "C0ENG",
        ts: "1713100000.000300",
        user: "dana",
        text: "Deploying the billing sync change tonight, see thread for the details everyone keeps asking about.",
        replies: [
          {
            user: "dana",
            ts: "1713100100.000301",
            text: "To be explicit: billing-sync-flow is the only writer to ledger_entries. Accounting reconciles against it monthly and there is no other path that populates that table.",
          },
        ],
      },
    ],
    expectedUrl: permalink("C0ENG", "1713100000.000300"),
    pins: "The top-level message is vague; the answer is in the thread. Rewards reading.",
  },

  /* ------------------------------------------------------- unanswerable */
  {
    name: "no-evidence-for-staging-table",
    class: "unanswerable",
    edge: {
      srcName: "public.tmp_import_batch",
      dstName: "public.staging_rows",
      edgeKind: "WRITES_TO",
    },
    planted: [
      {
        channel: "C0ENG",
        ts: "1713200000.000400",
        user: "dana",
        text: "Standup at 10 moved to 10:30 today.",
      },
    ],
    pins: "Nothing explains this edge. Giving up is the only correct answer, and inventing a reason here is the failure the whole design exists to prevent.",
  },
  {
    name: "empty-workspace",
    class: "unanswerable",
    edge: {
      srcName: "public.audit_shadow",
      dstName: "public.audit_shadow_archive",
      edgeKind: "WRITES_TO",
    },
    planted: [],
    pins: "Not a single message. An agent that proposes anything here is fabricating outright.",
  },

  /* -------------------------------------------------------------- decoy */
  {
    name: "decoy-similar-column-name",
    class: "decoy",
    edge: {
      srcName: "public.orders.tax_rate",
      dstName: "quarterly_revenue_report",
      edgeKind: "READS_FROM",
    },
    planted: [
      {
        channel: "C0FINANCE",
        ts: "1713300000.000500",
        user: "priya",
        text: "eu_vat_report reads invoices.vat_rate and finance signs it off quarterly.",
      },
    ],
    forbiddenUrls: [permalink("C0FINANCE", "1713300000.000500")],
    pins: "A plausible message about a *different* column and a *different* report. Citing it is confabulation dressed as diligence; giving up is correct.",
  },
  {
    name: "decoy-right-table-wrong-claim",
    class: "decoy",
    edge: {
      srcName: "public.subscriptions.plan_id",
      dstName: "churn_dashboard",
      edgeKind: "READS_FROM",
    },
    planted: [
      {
        channel: "C0ENG",
        ts: "1713400000.000600",
        user: "marcus",
        text: "subscriptions.plan_id is going away next quarter, we are migrating to the new pricing table.",
      },
    ],
    forbiddenUrls: [permalink("C0ENG", "1713400000.000600")],
    pins: "Mentions the right column but says nothing about why the dashboard depends on it. Relevance is not evidence.",
  },
];

export { permalink };
