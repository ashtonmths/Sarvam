/**
 * Shared across the four legal pages so an effective date can never be right
 * on one page and stale on another.
 */

export const EFFECTIVE = "26 July 2026";
export const VERSION = "1.0";

/**
 * The review status, stated at the top of every page rather than buried.
 *
 * Publishing a policy drafted from reputable baselines with counsel review
 * still pending is an honest thing for a beta to do. Implying it has been
 * reviewed when it has not is not, and the difference is one sentence — so the
 * sentence is here, on every page, above the text it qualifies.
 */
export const REVIEW_NOTICE = (
  <>
    <strong>Drafted, not yet reviewed by counsel.</strong> These terms were written from
    standard SaaS baselines and checked line by line against what the code actually does.
    They have not been through legal review, and the operating entity is not yet
    incorporated. Sadhak is in open beta and free to use. If you need a counsel-reviewed
    agreement before connecting a production system, tell us and we will not pretend
    otherwise.
  </>
);
