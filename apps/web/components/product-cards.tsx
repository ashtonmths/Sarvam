/**
 * Product tableau cards. Everything shown is true to the seeded demo company:
 * the field, the impacted flows, the impact scores and the rationale thread
 * all exist in the seed data, so marketing and product never drift apart.
 */

export function ChangeCard() {
  return (
    <div className="pcard">
      <div className="pcard__eyebrow">
        <span>Airtable · change detected</span>
        <span>14:03:07</span>
      </div>
      <div className="pcard__title">Field deleted: vat_rate</div>
      <p className="pcard__meta">Invoices table · by K. Rao · looked unused</p>
      <div className="pcard__divider" />
      <div className="impact-row" style={{ gridTemplateColumns: "1fr auto" }}>
        <span>webhook received</span>
        <span>+2.1s</span>
      </div>
    </div>
  );
}

export function VerdictCard() {
  return (
    <div className="pcard pcard--verdict">
      <div className="pcard__eyebrow">
        <span>Verdict · deterministic</span>
        <span>41ms</span>
      </div>
      <div style={{ display: "flex", alignItems: "center", gap: 12, marginBottom: 10 }}>
        <span className="verdict-tag verdict-tag--block">
          <span className="verdict-tag__dot" />
          Block
        </span>
        <span className="pcard__meta" style={{ fontFamily: "var(--font-mono)" }}>
          Invoices.vat_rate
        </span>
      </div>

      <div className="impact-row">
        <span>billing-sync-flow</span>
        <span className="impact-row__bar" style={{ width: 64 }}>
          <span className="impact-row__fill" style={{ width: "94%" }} />
        </span>
        <span>0.94</span>
      </div>
      <div className="impact-row impact-row--dim">
        <span>eu-vat-report</span>
        <span className="impact-row__bar" style={{ width: 64 }}>
          <span className="impact-row__fill" style={{ width: "56%" }} />
        </span>
        <span>0.56</span>
      </div>
      <div className="impact-row impact-row--dim">
        <span>finance-dashboard</span>
        <span className="impact-row__bar" style={{ width: 64 }}>
          <span className="impact-row__fill" style={{ width: "20%" }} />
        </span>
        <span>0.20</span>
      </div>

      <div className="pcard__divider" />
      <blockquote className="rationale-quote" style={{ margin: 0 }}>
        &ldquo;feeds EU VAT reporting&rdquo; · <strong>@priya</strong> in #ops,
        Mar 2024
      </blockquote>
    </div>
  );
}

export function HistorianTrace() {
  return (
    <div className="pcard trace" style={{ width: "100%" }}>
      <div className="pcard__eyebrow">
        <span>Trace · historian</span>
        <span>edge vat_rate → billing-sync</span>
      </div>
      <div className="trace__line">
        <span className="trace__step">1</span>
        <span className="trace__tool">get_edge_context</span>
        <span className="trace__note">12ms</span>
      </div>
      <div className="trace__line">
        <span className="trace__step">2</span>
        <span className="trace__tool">search_slack</span>
        <span className="trace__note">&ldquo;vat_rate&rdquo; · 3 hits</span>
      </div>
      <div className="trace__line">
        <span className="trace__step">3</span>
        <span className="trace__tool">read_thread</span>
        <span className="trace__note">#ops · Mar 2024</span>
      </div>
      <div className="trace__line">
        <span className="trace__step">4</span>
        <span className="trace__tool">propose_rationale</span>
        <span className="trace__note">confidence 0.86</span>
      </div>
      <div className="trace__line">
        <span className="trace__step">→</span>
        <span className="trace__result">drafted, awaiting human review</span>
      </div>
    </div>
  );
}

export function GiveUpTrace() {
  return (
    <div className="pcard trace" style={{ width: "100%" }}>
      <div className="pcard__eyebrow">
        <span>Trace · historian</span>
        <span>edge legacy_export → s3-dump</span>
      </div>
      <div className="trace__line">
        <span className="trace__step">1</span>
        <span className="trace__tool">search_slack</span>
        <span className="trace__note">0 hits</span>
      </div>
      <div className="trace__line">
        <span className="trace__step">2</span>
        <span className="trace__tool">search_github</span>
        <span className="trace__note">1 commit, no context</span>
      </div>
      <div className="trace__line">
        <span className="trace__step">→</span>
        <span className="trace__giveup">gave_up: not enough evidence</span>
      </div>
    </div>
  );
}

export function AgentRefusal() {
  return (
    <div className="pcard trace" style={{ width: "100%" }}>
      <div className="pcard__eyebrow">
        <span>MCP · proxy gate</span>
        <span>agent: ops-cleanup-bot</span>
      </div>
      <div className="trace__line">
        <span className="trace__step">→</span>
        <span className="trace__tool">propose_change</span>
        <span className="trace__note">delete Invoices.vat_rate</span>
      </div>
      <div className="trace__line">
        <span className="trace__step">←</span>
        <span style={{ color: "var(--block)", fontWeight: 500 }}>
          refused: blast radius 0.94
        </span>
        <span className="trace__note">mutation never forwarded</span>
      </div>
    </div>
  );
}
