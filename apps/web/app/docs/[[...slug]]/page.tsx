import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { MDXRemote } from "next-mdx-remote/rsc";
import remarkGfm from "remark-gfm";
import { DocsSearch } from "../../../components/docs-search";
import { Footer } from "../../../components/footer";
import { Nav } from "../../../components/nav";
import {
  allSlugs,
  docsTree,
  getDoc,
  searchIndex,
  slugifyHeading,
} from "../../../lib/docs";

/**
 * Every docs page, rendered at build time.
 *
 * Server-rendered MDX with no client JavaScript except the search box — the
 * content is prose and prose does not need a runtime. That also means the docs
 * are readable by an agent that fetches the HTML, which matters here more than
 * most places: half the audience for this product is something that reads
 * rather than someone who looks.
 */

export const dynamicParams = false;

export function generateStaticParams() {
  return allSlugs().map((slug) => ({ slug: slug.length === 0 ? undefined : slug }));
}

export async function generateMetadata({
  params,
}: {
  params: Promise<{ slug?: string[] }>;
}): Promise<Metadata> {
  const { slug = [] } = await params;
  try {
    const doc = getDoc(slug);
    return { title: doc.title, description: doc.description };
  } catch {
    return { title: "Docs" };
  }
}

/** Headings get ids so the table of contents can link to them. */
const components = {
  h2: ({ children }: { children?: React.ReactNode }) => (
    <h2 id={slugifyHeading(String(children))}>{children}</h2>
  ),
  h3: ({ children }: { children?: React.ReactNode }) => (
    <h3 id={slugifyHeading(String(children))}>{children}</h3>
  ),
  a: ({ href, children }: { href?: string; children?: React.ReactNode }) =>
    href?.startsWith("/") ? (
      <Link href={href}>{children}</Link>
    ) : (
      <a href={href} target="_blank" rel="noreferrer">
        {children}
      </a>
    ),
};

export default async function DocsPage({
  params,
}: {
  params: Promise<{ slug?: string[] }>;
}) {
  const { slug = [] } = await params;

  let doc: ReturnType<typeof getDoc>;
  try {
    doc = getDoc(slug);
  } catch {
    notFound();
  }

  const tree = docsTree();
  const groups = new Map<string, typeof tree>();
  for (const page of tree) {
    const key = page.group ?? "";
    groups.set(key, [...(groups.get(key) ?? []), page]);
  }

  const flat = tree.map((page) => page.href);
  const here = flat.indexOf(doc.href);
  const previous = here > 0 ? tree[here - 1] : undefined;
  const next = here >= 0 && here < tree.length - 1 ? tree[here + 1] : undefined;

  return (
    <>
      <Nav />

      <div className="container docs">
        <aside className="docs__side">
          <DocsSearch index={searchIndex()} />

          <nav className="docs__nav" aria-label="Documentation">
            {[...groups.entries()].map(([group, pages]) => (
              <div key={group || "root"} className="docs__group">
                {group && <span className="docs__group-title">{group}</span>}
                {pages.map((page) => (
                  <Link
                    key={page.href}
                    href={page.href}
                    className="docs__nav-link"
                    aria-current={page.href === doc.href ? "page" : undefined}
                  >
                    {page.title}
                  </Link>
                ))}
              </div>
            ))}
          </nav>
        </aside>

        <main className="docs__main">
          <article className="docs__body">
            <h1 className="docs__title">{doc.title}</h1>
            {doc.description && <p className="docs__lede">{doc.description}</p>}

            {/* remark-gfm, because without it a pipe table renders as a
                paragraph full of pipe characters — which is exactly how the
                Reflex page shipped its "what a revert restores" table on the
                first build. Tables, strikethrough and task lists are all GFM
                extensions rather than core markdown. */}
            <MDXRemote
              source={doc.body}
              components={components}
              options={{ mdxOptions: { remarkPlugins: [remarkGfm] } }}
            />
          </article>

          <nav className="docs__pager" aria-label="More pages">
            {previous ? (
              <Link href={previous.href} className="docs__pager-link">
                <span>Previous</span>
                {previous.title}
              </Link>
            ) : (
              <span />
            )}
            {next && (
              <Link href={next.href} className="docs__pager-link docs__pager-link--next">
                <span>Next</span>
                {next.title}
              </Link>
            )}
          </nav>

          {/* The same courtesy the product extends with `last_seen` on an edge:
              say how old this is so a reader can judge it, rather than making
              them guess. */}
          {doc.updated && (
            <p className="docs__updated">
              Last updated {doc.updated} ·{" "}
              <a
                href={`https://github.com/ashtonmths/Sarvam/blob/main/apps/web/content/docs/${
                  doc.slug.length === 0 ? "index" : doc.slug.join("/")
                }.mdx`}
                target="_blank"
                rel="noreferrer"
              >
                edit this page
              </a>
            </p>
          )}
        </main>

        <aside className="docs__toc" aria-label="On this page">
          {doc.headings.length > 1 && (
            <>
              <span className="docs__toc-title">On this page</span>
              {doc.headings.map((heading) => (
                <a
                  key={heading.id}
                  href={`#${heading.id}`}
                  className={`docs__toc-link${heading.depth === 3 ? " docs__toc-link--sub" : ""}`}
                >
                  {heading.text}
                </a>
              ))}
            </>
          )}
        </aside>
      </div>

      <Footer />
    </>
  );
}
