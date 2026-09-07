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
  const previewMode = view.previewMode as unknown as { renderer?: { previewEl?: HTMLElement } };
  if (previewMode.renderer?.previewEl) return previewMode.renderer.previewEl;
  return view.previewMode.containerEl.querySelector<HTMLElement>('.markdown-preview-view');
}

/** Internal reading-view renderer shape (not in the public typings; guarded). */
interface PreviewRendererInternals {
  renderer?: {
    previewEl?: HTMLElement;
    getScroll?: () => number | null;
  };
}

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
    const renderer = (view.previewMode as unknown as PreviewRendererInternals | undefined)?.renderer;
    if (renderer && typeof renderer.getScroll === 'function') {
      const line = renderer.getScroll();
      if (typeof line === 'number' && Number.isFinite(line)) return line;
    }
  } catch {
    // Renderer not ready — fall through to the synced value.
  }
  const synced = (view as unknown as { scroll?: unknown }).scroll;
  return typeof synced === 'number' && Number.isFinite(synced) ? synced : null;
}

/**
 * Slack (in lines) when deciding which heading is "current": a heading counts
 * as current once its line is within this many lines below the viewport-top
 * line. This replaces the old `scrollTop + 30px` DOM threshold. It must stay
 * < 1 line: after a jump the target line lands exactly at the viewport top
 * (offset 0), so this slack is the whole landing margin, and at exact landing
 * an adjacent heading (target line + 1) can only intrude if the slack reaches
 * a full line.
 */
const PREVIEW_LINE_EPSILON = 0.75;

/** Time to let the renderer re-measure the newly attached section window
 *  after a long jump before correcting the landing (see scrollToPreviewHeading). */
const JUMP_CORRECT_MS = 250;

/**
 * Reading mode chain. Preferred path is line-accurate and DOM-free: the
 * virtualized renderer itself maintains the current scroll position as a
 * fractional source line (`renderer.getScroll()` — the same value the outline
 * panel highlights from), so the chain is a pure metadata computation. When
 * that value is not yet available (initial progressive render), fall back to
 * locating the rendered DOM heading window via subsequence matching.
 */
export function computePreviewHeadingTrail(app: { metadataCache: { getFileCache(f: TFile): { headings?: HeadingCache[] } | null } }, view: MarkdownView): Crumb[] {
  const file = view.file;
  if (!file) return [];
  const metaHeadings = app.metadataCache.getFileCache(file)?.headings ?? [];
  if (metaHeadings.length === 0) return [];

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
  const threshold = scrollTop + 30;

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

  // The current position is the last rendered heading above the viewport top;
  // if none qualifies, it is whatever precedes the rendered window.
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
 * Jump to a heading in reading mode through the official internal path — the
 * exact call the outline panel makes when a heading is clicked:
 * `view.setEphemeralState({ line })` →
 * `renderer.applyScrollDelayed(line, { highlight: true }, syncScroll)`.
 * The renderer maps the line to a pixel offset from its *measured* section
 * heights (it refuses and retries once rendering settles if any height is not
 * measured yet), scrolls exactly once, flashes the target heading and syncs
 * the view's scroll state.
 *
 * One correction pass follows: a long jump re-attaches the rendered section
 * window, and re-measuring those sections (margins collapse differently with
 * their new neighbours) can shift the content by ~a hundred px shortly after
 * the landing. Once that settles, `applyScroll(line)` is exact again with the
 * fresh heights (verified: repeated application lands within 0.02 lines), so
 * we simply re-apply — no observation loop. Skipped if the user scrolled away
 * in the meantime. The legacy convergence loop is kept as a fallback for
 * internal API changes.
 */
export async function scrollToPreviewHeading(app: { metadataCache: { getFileCache(f: TFile): { headings?: HeadingCache[] } | null } }, view: MarkdownView, line: number, text?: string): Promise<void> {
  const previewEl = getPreviewEl(view);
  if (!previewEl) return;

  let official = false;
  try {
    if (typeof view.setEphemeralState === 'function') {
      view.setEphemeralState({ line });
      official = true;
    }
  } catch {
    // Internal renderer API unavailable or changed — use the legacy loop.
  }
  if (!official) {
    await scrollToPreviewHeadingLegacy(app, view, line, text);
    return;
  }

  await settle(JUMP_CORRECT_MS);

  // Re-land precisely now that the new section window has been re-measured.
  const renderer = (view.previewMode as unknown as {
    renderer?: { getScroll?: () => number | null; applyScroll?: (line: number, opts?: Record<string, never>) => boolean };
  })?.renderer;
  try {
    const gs = typeof renderer?.getScroll === 'function' ? renderer.getScroll() : null;
    if (typeof gs === 'number' && Math.abs(gs - line) > 10) return; // user scrolled away
    if (typeof renderer?.applyScroll === 'function') renderer.applyScroll(line, {});
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
    previewEl.scrollTo({ top: previewEl.scrollTop + delta - 8, behavior: 'smooth' });
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
