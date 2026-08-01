import { allSlugs, getDoc } from "../../../../lib/docs";

/**
 * The markdown source of a docs page.
 *
 * Served so an agent integrating against the MCP guide can read the guide
 * without parsing HTML. Frontmatter is stripped and the title put back as a
 * heading, so what arrives is a clean document rather than a page with its
 * metadata bolted on top.
 */
export const dynamic = "force-static";

export function generateStaticParams() {
  return allSlugs().map((slug) => ({ slug: slug.length === 0 ? ["index"] : slug }));
}

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ slug: string[] }> },
): Promise<Response> {
  const { slug } = await params;
  const real = slug.length === 1 && slug[0] === "index" ? [] : slug;

  try {
    const doc = getDoc(real);
    return new Response(`# ${doc.title}\n\n> ${doc.description}\n${doc.body}`, {
      headers: { "content-type": "text/markdown; charset=utf-8" },
    });
  } catch {
    return new Response("Not found\n", {
      status: 404,
      headers: { "content-type": "text/plain; charset=utf-8" },
    });
  }
}
