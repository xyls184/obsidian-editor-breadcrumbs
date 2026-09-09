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
 * Build the current chain of headings for the cursor position, VS Code style:
 * one crumb per heading level, only the innermost current heading of each level.
 */
export function headingChainFromCache(headings: HeadingCache[], cursorLine: number): HeadingCache[] {
  const chain: HeadingCache[] = [];
  for (const heading of headings) {
    if (heading.position.start.line > cursorLine) break;
    while (chain.length > 0 && chain[chain.length - 1].level >= heading.level) {
      chain.pop();
    }
    chain.push(heading);
  }
  return chain;
}

/** Chain of headings for a cursor line, computed from the metadata cache. */
export function computeEditHeadingTrail(app: { metadataCache: { getFileCache(f: TFile): { headings?: HeadingCache[] } | null } }, file: TFile | null, cursorLine: number): Crumb[] {
  if (!file) return [];
  const headings = app.metadataCache.getFileCache(file)?.headings ?? [];
  return headingChainFromCache(headings, cursorLine).map(h => ({
    text: stripMarkdown(h.heading),
    kind: 'heading' as const,
    line: h.position.start.line,
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
  const metaHeadings = app.metadataCache.getFileCache(file)?.headings ?? [];
  if (metaHeadings.length === 0) return [];

  const centerLine = getPreviewCenterLine(view);
  if (centerLine != null) {
    return headingChainFromCache(metaHeadings, centerLine).map(h => ({
      text: stripMarkdown(h.heading),
      kind: 'heading' as const,
      line: h.position.start.line,
    }));
  }
  const scrollLine = getPreviewScrollLine(view);
  if (scrollLine != null) {
    return headingChainFromCache(metaHeadings, scrollLine + PREVIEW_LINE_EPSILON).map(h => ({
      text: stripMarkdown(h.heading),
      kind: 'heading' as const,
      line: h.position.start.line,
    }));
  }
  return computePreviewHeadingTrailDom(app, view);
}

/**
 * Legacy fallback: reading mode renders only a window of the document around
 * the viewport (virtualized DOM), so the heading chain must come from the
 * metadata cache. The rendered DOM headings are matched against the metadata
 * as a contiguous subsequence to locate the current window, then the chain is
 * rebuilt from the full heading list.
 */
function computePreviewHeadingTrailDom(app: { metadataCache: { getFileCache(f: TFile): { headings?: HeadingCache[] } | null } }, view: MarkdownView): Crumb[] {
  const previewEl = getPreviewEl(view);
  const file = view.file;
  if (!previewEl || !file) return [];

  const metaHeadings = app.metadataCache.getFileCache(file)?.headings ?? [];
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

  const chainResult: HeadingCache[] = [];
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

/** Current rendered heading window mapped to metadata indices, or null. */
function matchPreviewWindow(metaHeadings: HeadingCache[], previewEl: HTMLElement, baseTop: number): { start: number; els: { el: HTMLElement; text: string }[] } | null {
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

  const headings = app.metadataCache.getFileCache(file)?.headings ?? [];
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
