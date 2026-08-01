"use client";

import Link from "next/link";
import { useEffect, useMemo, useRef, useState } from "react";

/**
 * Search, over an index built at build time and shipped with the page.
 *
 * No server, no external service, no request per keystroke. The whole index is
 * titles, descriptions and headings — a few kilobytes for a docs tree this
 * size, and those are what people actually type. Full-text would be larger and
 * would mostly match prose that does not answer the question.
 */

export interface SearchEntry {
  href: string;
  title: string;
  description: string;
  group: string;
  headings: string[];
}

export function DocsSearch({ index }: { index: SearchEntry[] }) {
  const [query, setQuery] = useState("");
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);
  const box = useRef<HTMLDivElement>(null);
  const input = useRef<HTMLInputElement>(null);

  const results = useMemo(() => {
    const terms = query.toLowerCase().split(/\s+/).filter(Boolean);
    if (terms.length === 0) return [];

    return index
      .map((entry) => {
        const haystack =
          `${entry.title} ${entry.description} ${entry.group} ${entry.headings.join(" ")}`.toLowerCase();
        // Every term must appear, so a second word narrows rather than widens.
        if (!terms.every((term) => haystack.includes(term))) return null;
        // A title match outranks a body match; people search for the page they
        // half-remember far more often than for a phrase inside it.
        const score = terms.reduce(
          (total, term) => total + (entry.title.toLowerCase().includes(term) ? 10 : 1),
          0,
        );
        return { entry, score };
      })
      .filter((hit): hit is { entry: SearchEntry; score: number } => hit !== null)
      .sort((a, b) => b.score - a.score)
      .slice(0, 8)
      .map((hit) => hit.entry);
  }, [query, index]);

  useEffect(() => setActive(0), [query]);

  // Slash focuses the box, escape leaves it. Both are what people try first.
  useEffect(() => {
    function onKey(event: KeyboardEvent) {
      const target = event.target as HTMLElement | null;
      const typing =
        target?.tagName === "INPUT" ||
        target?.tagName === "TEXTAREA" ||
        target?.isContentEditable;

      if (event.key === "/" && !typing) {
        event.preventDefault();
        input.current?.focus();
      }
      if (event.key === "Escape") {
        setOpen(false);
        input.current?.blur();
      }
    }
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, []);

  useEffect(() => {
    function onClick(event: MouseEvent) {
      if (!box.current?.contains(event.target as Node)) setOpen(false);
    }
    document.addEventListener("mousedown", onClick);
    return () => document.removeEventListener("mousedown", onClick);
  }, []);

  return (
    <div className="docs__search" ref={box}>
      <input
        ref={input}
        type="search"
        className="docs__search-input"
        placeholder="Search the docs…"
        aria-label="Search the documentation"
        value={query}
        onChange={(event) => {
          setQuery(event.target.value);
          setOpen(true);
        }}
        onFocus={() => setOpen(true)}
        onKeyDown={(event) => {
          if (results.length === 0) return;
          if (event.key === "ArrowDown") {
            event.preventDefault();
            setActive((i) => (i + 1) % results.length);
          }
          if (event.key === "ArrowUp") {
            event.preventDefault();
            setActive((i) => (i - 1 + results.length) % results.length);
          }
          if (event.key === "Enter") {
            const hit = results[active];
            if (hit) window.location.href = hit.href;
          }
        }}
      />
      {/* No aria-hidden and no role override. A `kbd` reading "slash" beside
          an input labelled "Search the documentation" tells a screen-reader
          user the shortcut exists, which is information they would otherwise
          never get — hiding it is a small loss dressed up as tidiness. */}
      <kbd className="docs__search-key">/</kbd>

      {open && query.length > 0 && (
        <div className="docs__search-results" role="listbox">
          {results.length === 0 ? (
            <p className="docs__search-empty">Nothing matches &ldquo;{query}&rdquo;.</p>
          ) : (
            results.map((entry, i) => (
              <Link
                key={entry.href}
                href={entry.href}
                className={`docs__search-hit${i === active ? " is-active" : ""}`}
                role="option"
                aria-selected={i === active}
                onClick={() => setOpen(false)}
              >
                <strong>{entry.title}</strong>
                <span>{entry.description}</span>
              </Link>
            ))
          )}
        </div>
      )}
    </div>
  );
}
