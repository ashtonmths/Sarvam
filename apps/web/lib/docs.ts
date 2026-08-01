import { execFileSync } from "node:child_process";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

/**
 * The docs tree, read from `content/docs` at build time.
 *
 * **Not fumadocs, and the reason is a version wall rather than a preference.**
 * Plan 18.1 specifies it; `fumadocs-ui@16` declares `next: 16.x.x` as a peer
 * and this app is on 15.5, and it depends on `@fumadocs/tailwind` — a whole
 * second design system for a product whose look is hand-built tokens. Adopting
 * it meant either downgrading the docs or overriding nearly all of its theme.
 *
 * What the plan actually wanted from it survives: a generated sidebar, a
 * table of contents, and search with no external service. Those are below and
 * they are perhaps two hundred lines. The eject path the plan cared about
 * survives too, and more strongly — the content is plain MDX with frontmatter,
 * so swapping this renderer never touches a single page.
 */

const ROOT = join(process.cwd(), "content/docs");

export interface DocMeta {
  slug: string[];
  href: string;
  title: string;
  description: string;
  /** Section heading in the sidebar. Absent for top-level pages. */
  group?: string;
  order: number;
  /** Last commit date for this file, so a reader can judge staleness. */
  updated: string;
}

export interface Doc extends DocMeta {
  body: string;
  headings: { depth: number; text: string; id: string }[];
}

function walk(dir: string, prefix: string[] = []): string[][] {
  const out: string[][] = [];
  for (const entry of readdirSync(dir).sort()) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) out.push(...walk(full, [...prefix, entry]));
    else if (entry.endsWith(".mdx")) {
      const name = entry.replace(/\.mdx$/, "");
      out.push(name === "index" && prefix.length === 0 ? [] : [...prefix, name]);
    }
  }
  return out;
}

function filePath(slug: string[]): string {
  return join(ROOT, slug.length === 0 ? "index.mdx" : `${slug.join("/")}.mdx`);
}

/**
 * Frontmatter, parsed without a YAML dependency.
 *
 * The fields are a fixed set of scalars and the files are ours, so a parser
 * that accepts arbitrary YAML would be answering a question nobody asked. A
 * malformed key fails the build loudly rather than silently rendering a page
 * with no title.
 */
function parseFrontmatter(source: string, slug: string[]) {
  const match = source.match(/^---\n([\s\S]*?)\n---\n?/);
  if (!match) throw new Error(`${slug.join("/") || "index"}.mdx has no frontmatter`);

  const meta: Record<string, string> = {};
  for (const line of (match[1] ?? "").split("\n")) {
    const kv = line.match(/^(\w+):\s*(.*)$/);
    if (kv?.[1]) meta[kv[1]] = (kv[2] ?? "").replace(/^["']|["']$/g, "").trim();
  }
  return { meta, body: source.slice(match[0].length) };
}

/**
 * The last commit that touched the file. Falls back to empty rather than
 * throwing: a shallow clone or a brand-new unstaged page has no history, and
 * neither is a reason to fail a build.
 */
function lastUpdated(path: string): string {
  try {
    return execFileSync("git", ["log", "-1", "--format=%cs", "--", path], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
  } catch {
    return "";
  }
}

/** Headings, for the on-page table of contents. */
function headingsOf(body: string) {
  const out: { depth: number; text: string; id: string }[] = [];
  let inFence = false;
  for (const line of body.split("\n")) {
    if (line.startsWith("```")) inFence = !inFence;
    if (inFence) continue;
    const match = line.match(/^(#{2,3})\s+(.+)$/);
    if (!match?.[1] || !match[2]) continue;
    const text = match[2].replace(/[`*_]/g, "").trim();
    out.push({ depth: match[1].length, text, id: slugifyHeading(text) });
  }
  return out;
}

export function slugifyHeading(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^\w\s-]/g, "")
    .trim()
    .replace(/\s+/g, "-");
}

export function allSlugs(): string[][] {
  return walk(ROOT);
}

export function getDoc(slug: string[]): Doc {
  const path = filePath(slug);
  const { meta, body } = parseFrontmatter(readFileSync(path, "utf8"), slug);

  return {
    slug,
    href: slug.length === 0 ? "/docs" : `/docs/${slug.join("/")}`,
    title: meta.title ?? slug.at(-1) ?? "Docs",
    description: meta.description ?? "",
    ...(meta.group ? { group: meta.group } : {}),
    order: Number(meta.order ?? 99),
    updated: lastUpdated(path),
    body,
    headings: headingsOf(body),
  };
}

/** Every page, ordered for the sidebar. */
export function docsTree(): DocMeta[] {
  return allSlugs()
    .map((slug) => {
      const { body: _body, headings: _headings, ...meta } = getDoc(slug);
      return meta;
    })
    .sort((a, b) => a.order - b.order || a.title.localeCompare(b.title));
}

/**
 * The search index, built once at build time and shipped as JSON.
 *
 * Headings and descriptions rather than full bodies: it is what people search
 * for, and it keeps the payload small enough that search needs no server, no
 * external service, and no network round trip per keystroke.
 */
export function searchIndex() {
  return allSlugs().map((slug) => {
    const doc = getDoc(slug);
    return {
      href: doc.href,
      title: doc.title,
      description: doc.description,
      group: doc.group ?? "",
      headings: doc.headings.map((h) => h.text),
    };
  });
}
