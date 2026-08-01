/**
 * Templates as typed functions returning plain strings.
 *
 * No react-email and no template engine: these are four emails, the HTML is
 * table-free and inline-styled because that is what mail clients render
 * reliably, and a rendering dependency would be a build step and a security
 * surface for something a template literal does correctly.
 *
 * Every template returns both `text` and `html`. The text part is not a
 * courtesy — a message with no plain-text alternative scores worse with spam
 * filters, and some people genuinely read mail that way.
 */

interface Rendered {
  subject: string;
  text: string;
  html: string;
}

const WRAP = (body: string) => `<!doctype html>
<html><body style="margin:0;padding:24px;background:#ebe9e2;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;color:#17191e">
<div style="max-width:520px;margin:0 auto;background:#fdfcfa;border:1px solid #d9d6cc;border-radius:16px;padding:28px">
${body}
<hr style="border:0;border-top:1px solid #e4e1d8;margin:24px 0">
<p style="font-size:12px;color:#636872;margin:0">Sadhak · <a href="https://sadhak.online/app" style="color:#4053c8">Open the app</a></p>
</div></body></html>`;

export function firstCrawlComplete(input: {
  orgName: string;
  nodes: number;
  edges: number;
  topNodes: string[];
}): Rendered {
  const top = input.topNodes.slice(0, 3);

  const text = `Your map is up.

Sadhak finished its first crawl of ${input.orgName} and found ${input.nodes} things and ${input.edges} dependencies between them.

The heaviest ones so far:
${top.map((n) => `  - ${n}`).join("\n")}

Your next step is a dry-run: pick a field that looks important and ask the gate what would break. It answers in about forty milliseconds and touches no model.

https://sadhak.online/app/simulate`;

  return {
    subject: `Your map of ${input.orgName} is ready`,
    text,
    html: WRAP(`<h1 style="font-size:20px;margin:0 0 12px">Your map is up</h1>
<p style="line-height:1.6;color:#575c66;margin:0 0 14px">Sadhak finished its first crawl of <strong>${input.orgName}</strong> and found <strong>${input.nodes}</strong> things and <strong>${input.edges}</strong> dependencies between them.</p>
<p style="line-height:1.6;color:#575c66;margin:0 0 6px">The heaviest ones so far:</p>
<ul style="line-height:1.7;color:#575c66;margin:0 0 18px">${top.map((n) => `<li><code>${n}</code></li>`).join("")}</ul>
<p style="line-height:1.6;color:#575c66;margin:0 0 18px">Your next step is a dry-run: pick a field that looks important and ask the gate what would break. It answers in about forty milliseconds and touches no model.</p>
<a href="https://sadhak.online/app/simulate" style="display:inline-block;background:#17191e;color:#fff;padding:10px 18px;border-radius:8px;text-decoration:none">Simulate a change</a>`),
  };
}

export function firstVerdict(input: {
  orgName: string;
  verdict: string;
  target: string;
  impacted: string[];
  decisionUrl: string;
}): Rendered {
  const text = `The gate answered for the first time.

  ${input.verdict} on ${input.target}

${
  input.impacted.length > 0
    ? `Because these depend on it:\n${input.impacted
        .slice(0, 4)
        .map((n) => `  - ${n}`)
        .join("\n")}`
    : "Nothing downstream depends on it, so the answer was approve."
}

The full evidence chain is on the decision:
${input.decisionUrl}

That verdict is deterministic. The same change against the same graph returns the same answer, every time, with no model involved.`;

  return {
    subject: `${input.verdict}: ${input.target}`,
    text,
    html: WRAP(`<h1 style="font-size:20px;margin:0 0 12px">The gate answered for the first time</h1>
<p style="margin:0 0 16px"><span style="display:inline-block;padding:4px 12px;border-radius:999px;background:#f8e5e0;color:#a5301a;font-weight:600;font-size:13px">${input.verdict}</span> <code style="font-size:13px">${input.target}</code></p>
${
  input.impacted.length > 0
    ? `<p style="line-height:1.6;color:#575c66;margin:0 0 6px">Because these depend on it:</p><ul style="line-height:1.7;color:#575c66;margin:0 0 18px">${input.impacted
        .slice(0, 4)
        .map((n) => `<li><code>${n}</code></li>`)
        .join("")}</ul>`
    : `<p style="line-height:1.6;color:#575c66;margin:0 0 18px">Nothing downstream depends on it, so the answer was approve.</p>`
}
<a href="${input.decisionUrl}" style="display:inline-block;background:#17191e;color:#fff;padding:10px 18px;border-radius:8px;text-decoration:none">See the evidence</a>
<p style="line-height:1.6;color:#636872;font-size:13px;margin:18px 0 0">That verdict is deterministic. The same change against the same graph returns the same answer, every time, with no model involved.</p>`),
  };
}

export function weeklyDigest(input: {
  orgName: string;
  gated: number;
  blocked: number;
  reverts: number;
  coverageDelta: number;
  pendingDrafts: number;
  staleCorrections: number;
}): Rendered {
  const lines = [
    `${input.gated} changes went through the gate, ${input.blocked} blocked.`,
    input.reverts > 0 ? `${input.reverts} reverted after the fact.` : null,
    input.coverageDelta !== 0
      ? `Coverage ${input.coverageDelta > 0 ? "up" : "down"} ${Math.abs(input.coverageDelta)} confirmed edges.`
      : null,
    input.pendingDrafts > 0 ? `${input.pendingDrafts} drafts waiting for a human.` : null,
    input.staleCorrections > 0
      ? `${input.staleCorrections} corrections older than 72 hours.`
      : null,
  ].filter((line): line is string => line !== null);

  const text = `Last week at ${input.orgName}

${lines.map((l) => `  - ${l}`).join("\n")}

https://sadhak.online/app/metrics

Coverage counts human-confirmed rationale only. Drafts nobody has reviewed are not in that number.`;

  return {
    subject: `${input.orgName}: ${input.gated} changes gated last week`,
    text,
    html: WRAP(`<h1 style="font-size:20px;margin:0 0 14px">Last week at ${input.orgName}</h1>
<ul style="line-height:1.8;color:#575c66;margin:0 0 18px;padding-left:20px">${lines.map((l) => `<li>${l}</li>`).join("")}</ul>
<a href="https://sadhak.online/app/metrics" style="display:inline-block;background:#17191e;color:#fff;padding:10px 18px;border-radius:8px;text-decoration:none">Open metrics</a>
<p style="line-height:1.6;color:#636872;font-size:12px;margin:18px 0 0">Coverage counts human-confirmed rationale only. Drafts nobody has reviewed are not in that number.</p>`),
  };
}
