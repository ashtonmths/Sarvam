import { LogoMark } from "./marks";

/**
 * What sits behind the sign-in door.
 *
 * This panel used to hold a pull quote, which is the default thing to put
 * beside a login form and says nothing a hundred other products could not say.
 * It shows a verdict instead — the same one the quickstart produces, from the
 * same seeded graph anybody who signs in is about to land on. `vat_rate` looks
 * unused; a VAT report reads it; the change is blocked. The whole product in
 * one glance, and nothing here is invented for the picture.
 *
 * The numbers are real and fixed on purpose. This is a static panel on an
 * unauthenticated page: fetching a live verdict would mean an unauthenticated
 * read of somebody's graph, which is exactly the thing this product refuses.
 */

const IMPACTED = [
  { name: "public.eu_vat_report", kind: "report", hops: 1, impact: 1.0 },
  { name: "billing-sync", kind: "workflow", hops: 2, impact: 0.62 },
  { name: "Invoices", kind: "table", hops: 2, impact: 0.4 },
];

export function AuthScene() {
  return (
    <div className="scene" aria-hidden="true">
      <div className="scene__frame">
        <p className="scene__eyebrow">A change, proposed</p>

        <p className="scene__change">
          <span className="scene__op">delete</span>
          <span className="scene__target">invoices.vat_rate</span>
        </p>

        {/* The thread. One line, drawn down through everything the change
            reaches, ending at the verdict — the labyrinth metaphor made
            structural rather than decorative. */}
        <ol className="scene__impacts">
          {IMPACTED.map((node) => (
            <li key={node.name} className="scene__impact">
              <span className="scene__hop">{node.hops}</span>
              <span className="scene__node">
                <span className="scene__name">{node.name}</span>
                <span className="scene__kind">{node.kind}</span>
              </span>
              <span className="scene__bar">
                <span
                  className="scene__fill"
                  style={{ width: `${Math.round(node.impact * 100)}%` }}
                />
              </span>
              <span className="scene__impact-value">{node.impact.toFixed(2)}</span>
            </li>
          ))}
        </ol>

        <div className="scene__verdict">
          <span className="scene__verdict-tag">BLOCK</span>
          <p>
            impact 1.00 on <span className="scene__inline">public.eu_vat_report</span>{" "}
            over trusted edges
          </p>
        </div>

        <p className="scene__foot">
          <LogoMark size={15} />
          Computed in 17ms, by arithmetic. No model was asked, and the same change always
          gives the same answer.
        </p>
      </div>
    </div>
  );
}
