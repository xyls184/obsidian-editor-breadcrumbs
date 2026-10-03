import { HeadingCache, MarkdownView, TFile } from 'obsidian';

export type CrumbKind = 'folder' | 'file' | 'heading';

export interface Crumb {
  /** Full untruncated display text. */
  text: string;
  kind: CrumbKind;
  /** For heading crumbs in edit mode: the line the heading starts at. */
  line?: number;
  /** For heading crumbs in preview mode: the DOM heading element. */
  el?: HTMLElement;
  /** Markdown heading level (1-6); the bar uses it to render skipped-level separators. */
  level?: number;
}

/** Strip common inline markdown so crumbs read like plain text. */
export function stripMarkdown(raw: string): string {
  return raw
    .replace(/\[\[([^\]|]*\|)?([^\]]*)\]\]/g, '$2') // [[link|alias]] / [[link]]
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1') // [text](url)
    .replace(/[*_~`]+/g, '')
    .replace(/\$/g, '')
    .replace(/\\\\/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * The part of a heading the trail needs. Structurally compatible with the
 * cache's HeadingCache, so cache lists assign directly; text-derived entries
 * carry only these fields.
 */
export interface HeadingRef {
  level: number;
  heading: string;
  position: { start: { line: number } };
}

/** Editor surface the text extraction needs (CodeMirror-compatible). */
export interface HeadingsSource {
  lineCount(): number;
  getLine(n: number): string;
}

/** Above this many lines the text scan is skipped (render-time budget). */
const TEXT_SCAN_LINE_LIMIT = 8000;

/**
 * Extract ATX headings (`#`..`######`) straight from the editor document.
 *
 * This mirrors what the editor renders, not what the cache indexes: the
 * metadata cache parser swallows the rest of a file after certain constructs
 * (a math block whose closing `$$` is followed by text on the same line is
 * enough — everything below stops being indexed, headings included), while
 * the editor keeps rendering those headings normally. Skipped: frontmatter,
 * fenced code blocks and `$$` math blocks (a `#`-leading line inside math is
 * LaTeX content, not a heading the editor renders). Known gap: setext
 * headings (underlined titles) are only ever recovered from the cache.
 */
export function extractHeadingsFromText(editor: HeadingsSource): HeadingRef[] {
  const headings: HeadingRef[] = [];
  const lineCount = editor.lineCount();
  if (lineCount <= 0) return headings;
  let i = 0;
  // Frontmatter: a `---` fence on line 0; YAML comments may look like headings.
  if (editor.getLine(0).trim() === '---') {
    i = 1;
    while (i < lineCount && !/^(---|\.\.\.)\s*$/.test(editor.getLine(i))) i++;
    i++; // past the closing fence (or EOF)
  }
  let fenceChar = '';
  let fenceLen = 0;
  let inMath = false;
  for (; i < lineCount; i++) {
    const raw = editor.getLine(i);
    const t = raw.replace(/\t/g, '    ');
    const fence = t.match(/^ {0,3}(`{3,}|~{3,})/);
    if (fence) {
      const ch = fence[1][0];
      const len = fence[1].length;
      if (!fenceChar) {
        fenceChar = ch;
        fenceLen = len;
      } else if (ch === fenceChar && len >= fenceLen && t.slice(fence[0].length).trim() === '') {
        fenceChar = '';
      }
      continue;
    }
    if (fenceChar) continue;
    // Math blocks by `$$` parity: a line with an odd count toggles state
    // (`$$` alone opens, `$$（text）` closes, `$$x=1$$` is even and stays out).
    // Inline code spans are stripped first so a literal `$$` inside backticks
    // cannot fake a toggle. A line that starts inside math is math content —
    // never a heading — even when it carries the closing `$$`.
    const startsInMath = inMath;
    const mathDollars = (t.replace(/`[^`]*`/g, '').match(/\$\$/g) ?? []).length;
    if (mathDollars % 2 === 1) inMath = !inMath;
    if (startsInMath) continue;
    const m = t.match(/^ {0,3}(#{1,6})(?:\s|$)/);
    if (!m) continue;
    headings.push({
      heading: raw.replace(/^ {0,3}#{1,6}\s*/, ''),
      level: m[1].length,
      position: { start: { line: i } },
    });
  }
  return headings;
}

/**
 * Headings the bar should trust: the metadata cache reconciled with an ATX
 * scan of the editor document. The cache desync is *usually* a suffix (the
 * parser drops everything after the offending line), but not always: the same
 * poison line also breaks the parser's math-block state, so a later `$$` pair
 * can make it swallow a middle region holding real headings while indexing
 * `#`-leading math content it no longer recognizes as math. The scan therefore
 * covers the whole document and the two lists are reconciled in line order:
 * cache entries ahead of the scan are kept (setext headings, which the scan
 * cannot see); at the first scan-ahead position the cache is provably desynced
 * from there on and the editor scan takes over. `scanBelowLine` is the
 * position the caller cares about (cursor / scroll line): when it is not past
 * the last cached heading the chain cannot reach any missing region and the
 * scan is skipped, which keeps healthy documents on the pure-cache fast path.
 * Residual boundary: a cursor *inside* a mid-document swallowed region (at or
 * above the last cached heading) still mirrors the core cache — and with it
 * the outline panel — until the position moves past.
 */
export function getEffectiveHeadings(app: { metadataCache: { getFileCache(f: TFile): { headings?: HeadingCache[] } | null } }, file: TFile | null, editor: HeadingsSource | null | undefined, scanBelowLine: number): HeadingRef[] {
  const cached: HeadingRef[] = file ? (app.metadataCache.getFileCache(file)?.headings ?? []) : [];
  if (!editor || cached.length >= TEXT_SCAN_LINE_LIMIT) return cached;
  const lastCached = cached.length > 0 ? cached[cached.length - 1].position.start.line : -1;
  if (scanBelowLine <= lastCached) return cached; // chain cannot reach the missing region
  if (editor.lineCount() - 1 <= lastCached) return cached; // nothing below the last cached heading
  if (editor.lineCount() > TEXT_SCAN_LINE_LIMIT) return cached; // too large to scan per render
  const scanned = extractHeadingsFromText(editor);
  if (scanned.length === 0) return cached;
  const merged: HeadingRef[] = [];
  let ci = 0;
  let si = 0;
  while (ci < cached.length && si < scanned.length) {
    const cl = cached[ci].position.start.line;
    const sl = scanned[si].position.start.line;
    if (cl === sl) {
      // Same heading seen by both — keep the cache entry (it carries the full
      // position data the scan does not).
      merged.push(cached[ci]);
      ci++;
      si++;
    } else if (cl < sl) {
      merged.push(cached[ci]); // cache-only entry (setext) — keep
      ci++;
    } else {
      // Scan-ahead: a real heading the cache missed — desync starts here.
      return [...merged, ...scanned.slice(si)];
    }
  }
  return [...merged, ...scanned.slice(si)];
}

/**
 * Build the current chain of headings for the cursor position, VS Code style:
 * one crumb per heading level, only the innermost current heading of each level.
 */
export function headingChainFromCache(headings: HeadingRef[], cursorLine: number): HeadingRef[] {
  const chain: HeadingRef[] = [];
  for (const heading of headings) {
    if (heading.position.start.line > cursorLine) break;
    while (chain.length > 0 && chain[chain.length - 1].level >= heading.level) {
      chain.pop();
    }
    chain.push(heading);
  }
  return chain;
}

/** Chain of headings for a cursor line; recovers a truncated cache from the editor text. */
export function computeEditHeadingTrail(app: { metadataCache: { getFileCache(f: TFile): { headings?: HeadingCache[] } | null } }, file: TFile | null, cursorLine: number, editor?: HeadingsSource | null): Crumb[] {
  if (!file) return [];
  const headings = getEffectiveHeadings(app, file, editor, cursorLine);
  return headingChainFromCache(headings, cursorLine).map(h => ({
    text: stripMarkdown(h.heading),
    kind: 'heading' as const,
    line: h.position.start.line,
    level: h.level,
  }));
}

/** The scrolling element of a reading view (typing-safe across app versions). */
export function getPreviewEl(view: MarkdownView): HTMLElement | null {
  // Internal renderer field, absent from the public typings.
  const previewMode = view.previewMode as unknown as PreviewModeInternals;
  if (previewMode.renderer?.previewEl) return previewMode.renderer.previewEl;
  return view.previewMode.containerEl.querySelector<HTMLElement>('.markdown-preview-view');
}

/** One section of the virtualized reading view (not in the public typings). */
interface PreviewSection {
  el?: HTMLElement;
  start?: { line?: number };
  /** Source lines covered by this section. */
  lines?: number;
  /** Measured pixel height; 0 until the section has been measured. */
  height?: number;
  computed?: boolean;
  /** False while collapsed: hidden content takes no space but keeps its lines. */
  shown?: boolean;
}

interface PreviewScrollOpts {
  center?: boolean;
  highlight?: boolean;
}

/** Internal reading-view renderer shape (not in the public typings; guarded). */
interface PreviewRendererInternals {
  previewEl?: HTMLElement;
  /** Space above the first section (sizer padding). */
  topSpace?: number;
  sections?: PreviewSection[];
  getScroll?: () => number | null;
  applyScroll?: (line: number, opts?: PreviewScrollOpts) => boolean;
  applyScrollDelayed?: (line: number, opts?: PreviewScrollOpts, done?: () => void) => void;
}

/** `view.previewMode` with its internal renderer reachable (typing-safe cast). */
type PreviewModeInternals = { renderer?: PreviewRendererInternals };

/**
 * Current reading position as a fractional *source line* — the very value the
 * virtualized renderer maintains itself. `renderer.getScroll()` maps the pixel
 * scroll position onto document lines using measured section heights (with
 * per-list-item refinement) and returns null until every section height has
 * been measured; in that window we fall back to the view's last synced line,
 * which Obsidian keeps updated on every scroll (`view.syncScroll()`).
 */
export function getPreviewScrollLine(view: MarkdownView): number | null {
  try {
    // Internal renderer field, absent from the public typings.
    const previewMode = view.previewMode as unknown as PreviewModeInternals | undefined;
    const renderer = previewMode?.renderer;
    if (renderer && typeof renderer.getScroll === 'function') {
      const line = renderer.getScroll();
      if (typeof line === 'number' && Number.isFinite(line)) return line;
    }
  } catch {
    // Renderer not ready — fall through to the synced value.
  }
  // `view.scroll` is the renderer-synced line, absent from the public typings.
  const viewInternals = view as unknown as { scroll?: unknown };
  const synced = viewInternals.scroll;
  return typeof synced === 'number' && Number.isFinite(synced) ? synced : null;
}

/**
 * Source line at a scroll offset (px from the top of the scrolled content).
 * Mirrors the renderer's own `getScroll()` walk — sections stacked by their
 * measured heights, collapsed sections taking no space — but evaluated at an
 * arbitrary offset instead of the viewport top. The result is section-granular
 * on purpose: every heading starts its own section, so the section containing
 * the offset is exactly the one that decides which heading is current. Returns
 * null until every section has been measured (same condition as getScroll()).
 */
function previewLineAtOffset(renderer: PreviewRendererInternals, y: number): number | null {
  const sections = renderer.sections;
  if (!Array.isArray(sections) || sections.length === 0) return null;
  let px = typeof renderer.topSpace === 'number' ? renderer.topSpace : 0;
  let line: number | null = null;
  for (const section of sections) {
    if (!section?.computed) return null;
    if (typeof section.start?.line === 'number') line = section.start.line;
    const height = section.shown === false ? 0 : section.height ?? 0;
    if (y < px + height) return line;
    px += height;
  }
  return line;
}

/**
 * Source line at the vertical center of the reading view, or null when the
 * renderer's section data is unavailable. The center — not the viewport top —
 * is what the bar follows: a heading becomes current once it crosses the middle
 * of the visible reading area.
 */
function getPreviewCenterLine(view: MarkdownView): number | null {
  try {
    // Internal renderer field, absent from the public typings.
    const previewMode = view.previewMode as unknown as PreviewModeInternals | undefined;
    const renderer = previewMode?.renderer;
    const previewEl = renderer?.previewEl ?? getPreviewEl(view);
    if (!renderer || !previewEl) return null;
    return previewLineAtOffset(renderer, previewEl.scrollTop + previewEl.clientHeight / 2);
  } catch {
    return null;
  }
}

/**
 * Slack (in lines) for the fallback path only, where the reading position comes
 * from `renderer.getScroll()` (the viewport-top line) because the section data
 * needed for the center line is not available yet. A heading counts as current
 * once its line is within this many lines below the viewport top; it must stay
 * < 1 line so an adjacent heading cannot intrude at an exact landing.
 */
const PREVIEW_LINE_EPSILON = 0.75;

/** Time to let the renderer re-measure the newly attached section window
 *  after a long jump before correcting the landing (see scrollToPreviewHeading). */
const JUMP_CORRECT_MS = 250;

/**
 * Reading mode chain. Preferred path is DOM-free: the virtualized renderer
 * keeps every section's measured height, so the source line at the vertical
 * center of the view is a pure data computation and the chain is a metadata
 * lookup (same line semantics as the outline panel, but read at the center
 * instead of the viewport top). Falls back to the viewport-top line while
 * sections are still being measured, then to the rendered DOM heading window.
 */
export function computePreviewHeadingTrail(app: { metadataCache: { getFileCache(f: TFile): { headings?: HeadingCache[] } | null } }, view: MarkdownView): Crumb[] {
  const file = view.file;
  if (!file) return [];

  const centerLine = getPreviewCenterLine(view);
  if (centerLine != null) {
    const headings = getEffectiveHeadings(app, file, view.editor, centerLine);
    return headingChainFromCache(headings, centerLine).map(h => ({
      text: stripMarkdown(h.heading),
      kind: 'heading' as const,
      line: h.position.start.line,
      level: h.level,
    }));
  }
  const scrollLine = getPreviewScrollLine(view);
  if (scrollLine != null) {
    const headings = getEffectiveHeadings(app, file, view.editor, scrollLine + PREVIEW_LINE_EPSILON);
    return headingChainFromCache(headings, scrollLine + PREVIEW_LINE_EPSILON).map(h => ({
      text: stripMarkdown(h.heading),
      kind: 'heading' as const,
      line: h.position.start.line,
      level: h.level,
    }));
  }
  return computePreviewHeadingTrailDom(app, view);
}

/**
 * Legacy fallback: reading mode renders only a window of the document around
 * the viewport (virtualized DOM), so the heading chain must come from the
 * heading list. The rendered DOM headings are matched against the list
 * as a contiguous subsequence to locate the current window, then the chain is
 * rebuilt from the full heading list.
 */
function computePreviewHeadingTrailDom(app: { metadataCache: { getFileCache(f: TFile): { headings?: HeadingCache[] } | null } }, view: MarkdownView): Crumb[] {
  const previewEl = getPreviewEl(view);
  const file = view.file;
  if (!previewEl || !file) return [];

  // Legacy path only — rare, so the full-list scan is always affordable here.
  const metaHeadings = getEffectiveHeadings(app, file, view.editor, Number.MAX_SAFE_INTEGER);
  if (metaHeadings.length === 0) return [];

  const base = previewEl.getBoundingClientRect();
  const scrollTop = previewEl.scrollTop;
  // Same reference point as the main path: the vertical center of the view.
  const threshold = scrollTop + previewEl.clientHeight / 2;

  const domHeadings = Array.from(previewEl.querySelectorAll<HTMLElement>('h1,h2,h3,h4,h5,h6')).map(el => ({
    el,
    level: parseInt(el.tagName.slice(1), 10) || 6,
    text: (el.textContent ?? '').replace(/\s+/g, ' ').trim(),
    top: el.getBoundingClientRect().top - base.top + scrollTop,
  }));
  if (domHeadings.length === 0) return [];

  const metaText = metaHeadings.map(h => stripMarkdown(h.heading).replace(/\s+/g, ' ').trim());

  // NOTE: newer Obsidian renders preview headings with their tag level shifted
  // (an H1 heading may be rendered as <h2>), so levels are NOT compared —
  // matching relies on heading text, strict first, then a loose pass.
  const loose = (s: string) => s.toLowerCase().replace(/[^a-z0-9\u4e00-\u9fff]/g, '');
  const findWindowStart = (strict: boolean): number => {
    const cmp = strict
      ? (mi: number, di: number) => metaText[mi] === domHeadings[di].text
      : (mi: number, di: number) => loose(metaText[mi]) === loose(domHeadings[di].text);
    for (let start = 0; start + domHeadings.length <= metaHeadings.length; start++) {
      let ok = true;
      for (let di = 0; di < domHeadings.length; di++) {
        if (!cmp(start + di, di)) {
          ok = false;
          break;
        }
      }
      if (ok) return start;
    }
    return -1;
  };

  let windowStart = findWindowStart(true);
  if (windowStart < 0) windowStart = findWindowStart(false);
  if (windowStart < 0) return [];

  // The current position is the last rendered heading above the viewport
  // center; if none qualifies, it is whatever precedes the rendered window.
  let currentIndex = windowStart - 1;
  for (let di = 0; di < domHeadings.length; di++) {
    if (domHeadings[di].top <= threshold) {
      currentIndex = windowStart + di;
    }
  }

  const chainResult: HeadingRef[] = [];
  for (let i = 0; i <= currentIndex && i < metaHeadings.length; i++) {
    while (chainResult.length > 0 && chainResult[chainResult.length - 1].level >= metaHeadings[i].level) {
      chainResult.pop();
    }
    chainResult.push(metaHeadings[i]);
  }

  return chainResult.map(h => ({
    text: stripMarkdown(h.heading),
    kind: 'heading' as const,
    line: h.position.start.line,
    level: h.level,
  }));
}

/**
 * Scroll a reading view to a heading identified by its source line. Prefers
 * the live DOM element when the heading is currently rendered; otherwise
 * estimates the offset from the renderer's section heights.
 */
const PREVIEW_SETTLE_MS = 220;

function listPreviewHeadings(previewEl: HTMLElement, baseTop: number): { el: HTMLElement; text: string }[] {
  return Array.from(previewEl.querySelectorAll<HTMLElement>('h1,h2,h3,h4,h5,h6')).map(el => ({
    el,
    text: (el.textContent ?? '').replace(/\s+/g, ' ').trim(),
  }));
}

async function settle(ms = PREVIEW_SETTLE_MS): Promise<void> {
  await new Promise(resolve => window.setTimeout(resolve, ms));
}

/** Current rendered heading window mapped to heading-list indices, or null. */
function matchPreviewWindow(metaHeadings: HeadingRef[], previewEl: HTMLElement, baseTop: number): { start: number; els: { el: HTMLElement; text: string }[] } | null {
  const domHeadings = listPreviewHeadings(previewEl, baseTop);
  if (domHeadings.length === 0) return null;
  const metaText = metaHeadings.map(h => stripMarkdown(h.heading).replace(/\s+/g, ' ').trim());
  const loose = (s: string) => s.toLowerCase().replace(/[^a-z0-9\u4e00-\u9fff]/g, '');

  // Preview heading tags may be level-shifted, so match by text only.
  const findStart = (strict: boolean): number => {
    const cmp = strict
      ? (mi: number, di: number) => metaText[mi] === domHeadings[di].text
      : (mi: number, di: number) => loose(metaText[mi]) === loose(domHeadings[di].text);
    for (let start = 0; start + domHeadings.length <= metaHeadings.length; start++) {
      let ok = true;
      for (let di = 0; di < domHeadings.length; di++) {
        if (!cmp(start + di, di)) {
          ok = false;
          break;
        }
      }
      if (ok) return start;
    }
    return -1;
  };

  let start = findStart(true);
  if (start < 0) start = findStart(false);
  return start >= 0 ? { start, els: domHeadings } : null;
}

/**
 * Jump to a heading in reading mode through the renderer's official internal
 * path: `renderer.applyScrollDelayed(line, { center: true, highlight: true },
 * syncScroll)` — the same call Obsidian makes for search-match navigation
 * (`view.setEphemeralState({ line })` is this minus `center`). The renderer
 * maps the line to a pixel offset from its *measured* section heights (it
 * refuses and retries once rendering settles if any height is not measured
 * yet), scrolls exactly once, flashes the target and syncs the view's state.
 *
 * `center` matters here: the breadcrumb reads the heading at the middle of the
 * view (getPreviewCenterLine), so centering the target makes it the deepest
 * crumb immediately after the jump. A top-aligned landing would instead expose
 * whatever heading happens to sit above the middle — with dense headings the
 * clicked heading would drop out of the bar entirely.
 *
 * One correction pass follows: a long jump re-attaches the rendered section
 * window, and re-measuring those sections (margins collapse differently with
 * their new neighbours) can shift the content by ~a hundred px shortly after
 * the landing. Once that settles, `applyScroll(line, { center: true })` is
 * exact again with the fresh heights (verified: repeated application lands
 * within 0.02 lines), so we simply re-apply — no observation loop. Skipped if
 * the user scrolled away in the meantime (the landing line is the reference,
 * since a centered landing does not sit at `line`). The legacy convergence
 * loop is kept as a fallback for internal API changes.
 */
export async function scrollToPreviewHeading(app: { metadataCache: { getFileCache(f: TFile): { headings?: HeadingCache[] } | null } }, view: MarkdownView, line: number, text?: string): Promise<void> {
  const previewEl = getPreviewEl(view);
  if (!previewEl) return;

  // Internal renderer fields, absent from the public typings.
  const previewMode = view.previewMode as unknown as PreviewModeInternals | undefined;
  const renderer = previewMode?.renderer;
  const viewInternals = view as unknown as { syncScroll?: () => void };
  const syncScroll = viewInternals.syncScroll;
  if (!renderer || typeof renderer.applyScrollDelayed !== 'function') {
    // Internal renderer API unavailable or changed — use the legacy loop.
    await scrollToPreviewHeadingLegacy(app, view, line, text);
    return;
  }

  let landed: number | null = null;
  try {
    renderer.applyScrollDelayed(line, { center: true, highlight: true }, () => {
      try {
        landed = renderer.getScroll?.() ?? null;
        if (typeof syncScroll === 'function') syncScroll.call(view);
      } catch {
        // Scroll-state sync is best-effort.
      }
    });
  } catch {
    await scrollToPreviewHeadingLegacy(app, view, line, text);
    return;
  }

  await settle(JUMP_CORRECT_MS);

  // Re-land precisely now that the new section window has been re-measured.
  try {
    const gs = renderer.getScroll?.() ?? null;
    if (landed != null && gs != null && Math.abs(gs - landed) > 10) return; // user scrolled away
    renderer.applyScroll?.(line, { center: true });
  } catch {
    // Keep the first-shot position; it was already close.
  }
}

/**
 * Legacy fallback: the virtualized preview only renders a window around the
 * viewport, so we jump proportionally and refine using the observed heading
 * window until the target heading is rendered, then land precisely on it.
 */
async function scrollToPreviewHeadingLegacy(app: { metadataCache: { getFileCache(f: TFile): { headings?: HeadingCache[] } | null } }, view: MarkdownView, line: number, text?: string): Promise<void> {
  const previewEl = getPreviewEl(view);
  const file = view.file;
  if (!previewEl || !file) return;

  // Target may be a text-recovered heading (truncated cache) — scan when the
  // target line sits below the last cached heading.
  const headings = getEffectiveHeadings(app, file, view.editor, line);
  if (headings.length === 0) return;

  const normalize = (s: string) => stripMarkdown(s).replace(/\s+/g, ' ').trim();
  const wanted = text != null ? normalize(text) : null;
  const targetIdx = headings.findIndex(h => h.position.start.line === line);
  if (targetIdx < 0) return;

  const baseTop = previewEl.getBoundingClientRect().top;
  const total = headings.length;
  const maxScroll = () => Math.max(0, previewEl.scrollHeight - previewEl.clientHeight);

  const landOn = (el: HTMLElement) => {
    const base = previewEl.getBoundingClientRect();
    const delta = el.getBoundingClientRect().top - base.top;
    // Center the heading, matching the main path and the bar's reference point.
    const centered = delta - (previewEl.clientHeight - el.offsetHeight) / 2;
    previewEl.scrollTo({ top: previewEl.scrollTop + centered, behavior: 'smooth' });
  };

  for (let iter = 0; iter < 7; iter++) {
    const window = matchPreviewWindow(headings, previewEl, baseTop);

    // Target already rendered: land precisely.
    if (window && wanted) {
      const match = window.els.find(h => h.text === wanted);
      if (match) {
        landOn(match.el);
        return;
      }
    }
    if (window && targetIdx >= window.start && targetIdx < window.start + window.els.length) {
      landOn(window.els[targetIdx - window.start].el);
      return;
    }

    // Not rendered: estimate the scroll offset from the observed window slope.
    const pos = window
      ? previewEl.scrollTop + (targetIdx - (window.start + (window.els.length - 1) / 2)) *
        (previewEl.clientHeight / Math.max(1, window.els.length))
      : (targetIdx / total) * maxScroll();
    previewEl.scrollTo({ top: Math.min(maxScroll(), Math.max(0, pos)) });
    await settle();
  }
}
