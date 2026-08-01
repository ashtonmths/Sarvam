/**
 * Chunking, as a pure function over text.
 *
 * Two passes, because the two jobs pull in opposite directions. Segmenting
 * finds boundaries a human would recognise — a speaker's turn, a subtitle cue,
 * a paragraph — and packing fills chunks up to a size the embedding model can
 * actually read. Doing only the first gives many tiny chunks that retrieve
 * badly; doing only the second cuts sentences and speaker turns in half, which
 * is the exact failure the Slack thread path already had.
 *
 * The size ceiling is not advisory. `bge-small-en` truncates at 512 tokens
 * with `truncation: true` hard-coded in the pipeline, so anything longer is
 * silently absent from its own vector — the chunk would be searchable by a
 * half it never embedded.
 */

/** ~4 characters per token. No tokenizer dependency, deliberately conservative. */
const CHARS_PER_TOKEN = 4;

/** Target size. Leaves headroom under the model's 512 so packing never flirts with it. */
const TARGET_TOKENS = 350;

/** Hard ceiling. A unit that exceeds this alone is the only thing ever split. */
const MAX_TOKENS = 450;

/** How much of the previous chunk to repeat, so a straddling passage survives. */
const OVERLAP_TOKENS = 60;

export interface Chunk {
  ordinal: number;
  body: string;
  speaker: string | null;
  startOffset: number;
  endOffset: number;
  tokenEstimate: number;
}

/** A boundary the text itself declares. Never split, unless it alone is too big. */
interface Unit {
  text: string;
  speaker: string | null;
  start: number;
  end: number;
}

export function estimateTokens(text: string): number {
  return Math.ceil(text.length / CHARS_PER_TOKEN);
}

/**
 * Normalizes line endings and strips a BOM, so offsets computed here index
 * into exactly the string that gets stored. A document whose stored content
 * differs from what was chunked has offsets that silently point at the wrong
 * span, which is worse than having none.
 */
export function normalizeText(raw: string): string {
  return raw.replace(/^﻿/, "").replace(/\r\n?/g, "\n");
}

export function chunkDocument(content: string): Chunk[] {
  const units = segment(content);
  return pack(units);
}

/* ---------------------------------------------------------------- segment */

const VTT_TIMESTAMP = /^\s*(?:\d+\s*\n)?\d{2}:\d{2}(?::\d{2})?[.,]\d{3}\s*-->/;

/**
 * `Name:` at the start of a line. Bounded length and no interior colon so it
 * matches "Priya Raman:" but not a prose line that happens to contain a colon,
 * and not a markdown "Note: ..." — a false speaker split is cheap, but a
 * false *merge* of two speakers into one unit is not.
 */
const SPEAKER_TURN = /^([A-Z][\w .'`-]{0,48}):[ \t]+(?=\S)/;

function segment(content: string): Unit[] {
  if (isSubtitle(content)) return segmentSubtitle(content);
  return segmentProse(content);
}

function isSubtitle(content: string): boolean {
  return VTT_TIMESTAMP.test(content) || content.trimStart().startsWith("WEBVTT");
}

/**
 * WebVTT and SRT. Cue timings are dropped and the text kept: the timings are
 * not quotable and would dominate an embedding of a short cue.
 *
 * Consecutive cues from the same speaker are merged, because subtitle files
 * break on reading speed rather than on meaning — one sentence routinely spans
 * three cues, and chunking on cues alone would make every one of them a
 * fragment.
 */
function segmentSubtitle(content: string): Unit[] {
  const units: Unit[] = [];

  for (const block of splitBlocks(content)) {
    const lines = block.text.split("\n");
    const kept: string[] = [];
    let offset = block.start;
    let textStart = -1;

    for (const line of lines) {
      const isMeta =
        VTT_TIMESTAMP.test(line) ||
        /^\s*\d+\s*$/.test(line) ||
        /^\s*WEBVTT/.test(line) ||
        /^\s*(NOTE|STYLE|REGION)\b/.test(line);
      if (!isMeta && line.trim()) {
        if (textStart === -1) textStart = offset;
        kept.push(line.trim());
      }
      offset += line.length + 1;
    }

    if (kept.length === 0) continue;

    const joined = kept.join(" ");
    const speakerMatch = SPEAKER_TURN.exec(joined);
    const speaker = speakerMatch?.[1]?.trim() ?? null;

    const previous = units.at(-1);
    if (previous && speaker !== null && previous.speaker === speaker) {
      previous.text = `${previous.text} ${joined.slice(speakerMatch?.[0].length ?? 0)}`;
      previous.end = block.end;
      continue;
    }
    if (previous && speaker === null && previous.speaker === null) {
      previous.text = `${previous.text} ${joined}`;
      previous.end = block.end;
      continue;
    }

    units.push({
      text: joined,
      speaker,
      start: textStart === -1 ? block.start : textStart,
      end: block.end,
    });
  }

  return units;
}

/**
 * Plain text and markdown. A speaker turn wins over a paragraph break, since a
 * transcript exported as plain text has both and the turn is the real boundary.
 */
function segmentProse(content: string): Unit[] {
  const units: Unit[] = [];

  for (const block of splitBlocks(content)) {
    // A block can hold several turns when a transcript uses single newlines.
    for (const turn of splitTurns(block)) {
      if (!turn.text.trim()) continue;
      units.push(turn);
    }
  }

  return units;
}

function splitTurns(block: { text: string; start: number; end: number }): Unit[] {
  const lines = block.text.split("\n");
  const units: Unit[] = [];
  let offset = block.start;
  let current: Unit | null = null;

  for (const line of lines) {
    const match = SPEAKER_TURN.exec(line);
    const isHeading = /^\s{0,3}#{1,6}\s/.test(line);

    if (match || isHeading) {
      if (current) units.push(current);
      current = {
        text: line,
        speaker: match?.[1]?.trim() ?? null,
        start: offset,
        end: offset + line.length,
      };
    } else if (current) {
      current.text = `${current.text}\n${line}`;
      current.end = offset + line.length;
    } else {
      current = { text: line, speaker: null, start: offset, end: offset + line.length };
    }
    offset += line.length + 1;
  }

  if (current) units.push(current);
  return units;
}

/** Blank-line separated blocks, carrying their offsets in the original text. */
function splitBlocks(
  content: string,
): Array<{ text: string; start: number; end: number }> {
  const blocks: Array<{ text: string; start: number; end: number }> = [];
  const parts = content.split(/\n{2,}/);
  let cursor = 0;

  for (const part of parts) {
    const start = content.indexOf(part, cursor);
    const resolved = start === -1 ? cursor : start;
    if (part.trim()) {
      blocks.push({ text: part, start: resolved, end: resolved + part.length });
    }
    cursor = resolved + part.length;
  }

  return blocks;
}

/* ------------------------------------------------------------------- pack */

function pack(units: Unit[]): Chunk[] {
  const chunks: Chunk[] = [];
  let pending: Unit[] = [];

  const flush = () => {
    if (pending.length === 0) return;
    chunks.push(toChunk(pending, chunks.length));
    // Carry the tail forward so a passage spanning the seam appears whole in
    // at least one chunk. Without it, a decision stated across a boundary is
    // retrievable from neither side.
    pending = overlapOf(pending);
  };

  for (const unit of units) {
    for (const piece of unit.text.length > MAX_TOKENS * CHARS_PER_TOKEN
      ? splitOversized(unit)
      : [unit]) {
      const projected = estimateTokens(bodyOf([...pending, piece]));
      if (pending.length > 0 && projected > TARGET_TOKENS) flush();

      // Still over after flushing means the overlap plus this piece is too
      // big, so drop the overlap rather than exceed the ceiling.
      if (estimateTokens(bodyOf([...pending, piece])) > MAX_TOKENS) pending = [];
      pending.push(piece);
    }
  }

  if (pending.length > 0) chunks.push(toChunk(pending, chunks.length));
  return dropOverlapOnlyTail(chunks);
}

function bodyOf(units: Unit[]): string {
  return units.map((u) => u.text.trim()).join("\n");
}

function toChunk(units: Unit[], ordinal: number): Chunk {
  const body = bodyOf(units);
  const speakers = new Set(units.map((u) => u.speaker).filter((s): s is string => !!s));
  return {
    ordinal,
    body,
    // Attributed only when the whole chunk is one voice. Naming one of three
    // speakers would be a claim the chunk does not support.
    speaker: speakers.size === 1 ? ([...speakers][0] ?? null) : null,
    startOffset: Math.min(...units.map((u) => u.start)),
    endOffset: Math.max(...units.map((u) => u.end)),
    tokenEstimate: estimateTokens(body),
  };
}

function overlapOf(units: Unit[]): Unit[] {
  const carried: Unit[] = [];
  let tokens = 0;
  for (let i = units.length - 1; i >= 0; i -= 1) {
    const unit = units[i];
    if (!unit) continue;
    const cost = estimateTokens(unit.text);
    if (tokens + cost > OVERLAP_TOKENS && carried.length > 0) break;
    carried.unshift(unit);
    tokens += cost;
    if (tokens >= OVERLAP_TOKENS) break;
  }
  return carried;
}

/**
 * The only place a unit is broken. Sentence boundaries first, and a hard
 * character cut only for text that has none — a single unbroken 10k-character
 * paragraph is pathological, but it must still produce chunks rather than one
 * chunk the model silently truncates.
 */
function splitOversized(unit: Unit): Unit[] {
  const limit = MAX_TOKENS * CHARS_PER_TOKEN;
  const sentences = unit.text.match(/[^.!?\n]+(?:[.!?]+|\n|$)/g) ?? [unit.text];

  const pieces: Unit[] = [];
  let buffer = "";
  let start = unit.start;

  const push = () => {
    if (!buffer) return;
    pieces.push({
      text: buffer,
      speaker: unit.speaker,
      start,
      end: start + buffer.length,
    });
    start += buffer.length;
    buffer = "";
  };

  for (const sentence of sentences) {
    for (const fragment of hardSplit(sentence, limit)) {
      if (buffer && buffer.length + fragment.length > limit) push();
      buffer += fragment;
    }
  }
  push();

  return pieces.length > 0 ? pieces : [unit];
}

function hardSplit(text: string, limit: number): string[] {
  if (text.length <= limit) return [text];
  const parts: string[] = [];
  for (let i = 0; i < text.length; i += limit) parts.push(text.slice(i, i + limit));
  return parts;
}

/**
 * A trailing chunk made only of the previous chunk's overlap carries no new
 * text, so it would be a duplicate result competing with its own source.
 */
function dropOverlapOnlyTail(chunks: Chunk[]): Chunk[] {
  if (chunks.length < 2) return chunks;
  const last = chunks.at(-1);
  const previous = chunks.at(-2);
  if (last && previous?.body.includes(last.body)) {
    return chunks.slice(0, -1).map((chunk, index) => ({ ...chunk, ordinal: index }));
  }
  return chunks;
}
