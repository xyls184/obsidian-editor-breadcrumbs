import { MarkdownView, Menu, TFile, WorkspaceLeaf } from 'obsidian';
import type { BreadcrumbsPlugin } from '../main';
import { Crumb, computeEditHeadingTrail, computePreviewHeadingTrail, getEffectiveHeadings, getPreviewEl, scrollToPreviewHeading, stripMarkdown } from './trail';

const SEPARATOR = '›';

/** Upper bound on extra separators: the level gap caps at H1 → H6. */
const MAX_SKIP_SEPARATORS = 5;

/**
 * Fallback delay for the render gate. Chromium defers requestAnimationFrame
 * while the window is hidden or occluded, so a boolean flag released only by
 * rAF can stay set for the whole hidden phase and swallow every later render
 * (the 1s poll then finds its snapshot already current and never re-schedules
 * — cursor-follow freezes permanently). The 64ms timer opens the same gate
 * whenever rAF does not arrive in time; when rAF arrives first (the normal
 * visible case) the timer just observes an already-open gate.
 */
const GATE_FALLBACK_MS = 64;

export class BreadcrumbBar {
  plugin: BreadcrumbsPlugin;
  leaf: WorkspaceLeaf;
  view: MarkdownView;
  barEl: HTMLElement;
  private scrollHandler: () => void;
  private rafPending = false;
  private pollTimer: number | undefined;
  private lastSnapshot = '';
  private lastRenderKey = '';
  /** True while barEl lives inside the native tab header (header mode). */
  private inHeader = false;

  constructor(plugin: BreadcrumbsPlugin, leaf: WorkspaceLeaf, view: MarkdownView) {
    this.plugin = plugin;
    this.leaf = leaf;
    this.view = view;
    this.barEl = createDiv('eb-bar');

    // Capture-phase scroll listener catches both the CM scroller and the
    // reading-mode preview scroller for this leaf.
    this.scrollHandler = () => this.scheduleRender();
  }

  /** Coalesce scroll-driven and poll-driven renders into one rAF — with a
   *  timer fallback so the gate can never wedge while the window is hidden
   *  (see GATE_FALLBACK_MS). */
  private scheduleRender() {
    if (this.rafPending) return;
    this.rafPending = true;
    const run = () => {
      if (!this.rafPending) return; // the rAF already rendered
      this.rafPending = false;
      this.render();
    };
    window.requestAnimationFrame(run);
    window.setTimeout(run, GATE_FALLBACK_MS);
  }

  mount() {
    const contentEl = this.view.contentEl;
    this.applyPlacement();
    contentEl.addEventListener('scroll', this.scrollHandler, { capture: true, passive: true });
    // Safety net: scroll restoration at startup and programmatic scrolling in
    // the virtualized reading view do not always dispatch scroll events.
    this.pollTimer = window.setInterval(() => this.checkRefresh(), 1000);
  }

  /** Place the bar per settings: inside .view-header-title-container (after
   *  the native folder/file path) or above the content. appendChild moves an
   *  already-placed bar, so calling this again when the setting flips
   *  mid-session re-homes it cleanly. Throws when the header is not ready so
   *  syncBars retries on the next layout-change. */
  private applyPlacement() {
    const contentEl = this.view.contentEl;
    const headerEl = this.plugin.settings.showInTabHeader
      ? this.view.containerEl.querySelector<HTMLElement>(':scope > .view-header > .view-header-title-container')
      : null;
    if (this.plugin.settings.showInTabHeader && !headerEl) {
      throw new Error('view header title container not ready');
    }
    if (headerEl) {
      headerEl.appendChild(this.barEl);
      this.barEl.addClass('eb-in-header');
      this.inHeader = true;
    } else {
      contentEl.prepend(this.barEl);
      this.barEl.removeClass('eb-in-header');
      this.inHeader = false;
    }
  }

  destroy() {
    const contentEl = this.view.contentEl;
    contentEl.removeEventListener('scroll', this.scrollHandler, { capture: true });
    if (this.pollTimer != null) {
      window.clearInterval(this.pollTimer);
      this.pollTimer = undefined;
    }
    contentEl.removeClass('eb-active');
    this.barEl.remove();
  }

  /** Cheap state fingerprint; re-render only when something relevant moved. */
  private checkRefresh() {
    const previewEl = this.view.getMode() === 'preview' ? getPreviewEl(this.view) : null;
    const cursor = this.view.editor?.getCursor('from');
    const snapshot = [
      this.view.getMode(),
      this.view.file?.path ?? '',
      // clientHeight is part of the fingerprint: the reading-mode chain reads
      // the center line, so a resize can change the chain without any scroll.
      previewEl ? `${Math.round(previewEl.scrollTop)}/${Math.round(previewEl.clientHeight)}/${previewEl.scrollHeight}` : '',
      cursor ? `${cursor.line}:${cursor.ch}` : '',
      this.plugin.settings.maxSegmentLength,
      this.plugin.settings.showFolderPath ? 1 : 0,
      this.plugin.settings.showFileName ? 1 : 0,
      this.plugin.settings.showInReadingMode ? 1 : 0,
      this.plugin.settings.hideWhenNoHeadings ? 1 : 0,
    ].join('|');
    if (snapshot === this.lastSnapshot) return;
    this.lastSnapshot = snapshot;
    this.scheduleRender();
  }

  private truncate(text: string): string {
    const max = this.plugin.settings.maxSegmentLength;
    if (max <= 0 || text.length <= max) return text;
    return `${text.slice(0, Math.max(1, max - 1)).trimEnd()}…`;
  }

  private buildCrumbs(): Crumb[] {
    const crumbs: Crumb[] = [];
    const file = this.view.file ?? this.view.previewMode.file;
    if (!file) return crumbs;

    const { settings } = this.plugin;

    // Header mode: the native tab header already shows the folder/file path,
    // so only the heading trail is rendered there.
    if (!this.inHeader) {
      if (settings.showFolderPath) {
        let parent = file.parent;
        const folders: Crumb[] = [];
        while (parent && parent.path !== '/') {
          folders.unshift({ text: parent.name, kind: 'folder' });
          parent = parent.parent;
        }
        crumbs.push(...folders);
      }

      if (settings.showFileName) {
        crumbs.push({ text: file.basename, kind: 'file' });
      }
    }

    if (this.view.getMode() === 'preview') {
      crumbs.push(...computePreviewHeadingTrail(this.plugin.app, this.view));
    } else {
      const cursor = this.view.editor?.getCursor('from');
      const line = cursor ? cursor.line : 0;
      crumbs.push(...computeEditHeadingTrail(this.plugin.app, file, line, this.view.editor));
    }

    return crumbs;
  }

  private revealInExplorer(target?: TFile) {
    // internalPlugins is not in the public typings
    const app = this.plugin.app as unknown as {
      internalPlugins?: {
        getPluginById?: (id: string) => { instance?: { revealInFolder?: (f: TFile) => void } } | undefined;
      };
    };
    const fileExplorer = app.internalPlugins?.getPluginById?.('file-explorer');
    const item = target ?? this.view.file ?? this.view.previewMode.file;
    if (!item) return;
    fileExplorer?.instance?.revealInFolder?.(item);
  }

  /**
   * VS Code style sibling menu: lists every heading that shares this crumb's
   * parent (all headings of the same level within the parent's span). The
   * current heading is flagged; picking any entry jumps to it.
   */
  private showSiblingMenu(crumb: Crumb, event: MouseEvent) {
    const file = this.view.file ?? this.view.previewMode.file;
    if (!file || crumb.line == null) return;

    // Full list including text-recovered headings: a truncated cache must not
    // hide later siblings (menus are user-initiated, so the scan is cheap).
    const headings = getEffectiveHeadings(this.plugin.app, file, this.view.editor, Number.MAX_SAFE_INTEGER);
    const idx = headings.findIndex(h => h.position.start.line === crumb.line);
    if (idx < 0) return;

    const level = headings[idx].level;

    // Nearest enclosing heading (lower level) above, and the end of its span.
    let parentIdx = -1;
    for (let i = idx - 1; i >= 0; i--) {
      if (headings[i].level < level) {
        parentIdx = i;
        break;
      }
    }
    const parentLevel = parentIdx >= 0 ? headings[parentIdx].level : 0;
    let end = headings.length;
    for (let i = parentIdx + 1; i < headings.length; i++) {
      if (headings[i].level <= parentLevel) {
        end = i;
        break;
      }
    }

    // Only true siblings: same level AND directly under the same parent.
    // (VS Code lists the sibling entries of the shared parent scope — never
    // the children nested under each sibling.) Walk the parent span with a
    // level stack; a heading is a sibling iff nothing else in the span is
    // still open above it once everything at its level or deeper is popped.
    const menu = new Menu();
    const stack: number[] = [];
    for (let i = parentIdx + 1; i < end; i++) {
      while (stack.length > 0 && headings[stack[stack.length - 1]].level >= headings[i].level) {
        stack.pop();
      }
      const isSibling = headings[i].level === level && stack.length === 0;
      if (isSibling) {
        const heading = headings[i];
        const text = stripMarkdown(heading.heading);
        const line = heading.position.start.line;
        menu.addItem(item => {
          // Full text in the menu by design: only the breadcrumb bar truncates.
          item.setTitle(text).onClick(() => {
            this.jumpToHeading({ text, kind: 'heading', line });
          });
          if (i === idx && typeof item.setChecked === 'function') {
            item.setChecked(true);
          }
        });
      }
      stack.push(i);
    }

    const rect = (event.currentTarget as HTMLElement).getBoundingClientRect();
    menu.showAtPosition({ x: rect.left, y: rect.bottom + 4 });
    // Obsidian's own placement right-aligns the menu against the crumb's left
    // edge when a left-aligned menu would overflow the viewport. VS Code
    // opens menus left-aligned under the clicked item instead, and pins the
    // overflowing side to the window edge. `dom` is a runtime field Menu
    // creates in its constructor; it is just missing from the public typings.
    // showAtPosition sets `left` synchronously, so correcting it in this same
    // task happens before paint.
    if ('dom' in menu) {
      const dom = menu.dom;
      if (dom instanceof HTMLElement) {
        const vw = dom.ownerDocument.body.clientWidth;
        dom.style.left = `${Math.max(0, Math.min(rect.left, vw - dom.offsetWidth))}px`;
      }
    }
  }

  private jumpToHeading(crumb: Crumb) {
    if (this.view.getMode() === 'preview' && crumb.line != null) {
      void scrollToPreviewHeading(this.plugin.app, this.view, crumb.line, crumb.text);
      return;
    }
    if (crumb.line != null && this.view.editor) {
      const editor = this.view.editor;
      editor.setCursor({ line: crumb.line, ch: 0 });
      editor.scrollIntoView({ from: { line: crumb.line, ch: 0 }, to: { line: crumb.line, ch: 0 } }, true);
      editor.focus();
    }
  }

  render() {
    const { settings } = this.plugin;

    // A settings flip moves the bar between the header and the content edge.
    if (settings.showInTabHeader !== this.inHeader) this.applyPlacement();

    // Visibility rules.
    const file = this.view.file ?? this.view.previewMode.file;
    let visible = !!file;
    if (visible && this.view.getMode() === 'preview' && !settings.showInReadingMode) {
      visible = false;
    }
    const crumbs = visible ? this.buildCrumbs() : [];
    const headingCount = crumbs.filter(c => c.kind === 'heading').length;
    if (visible && settings.hideWhenNoHeadings && headingCount === 0) {
      visible = false;
    }

    this.barEl.toggleClass('eb-hidden', !visible);
    // eb-active shrinks the content by the bar height — bar mode only; the
    // header-mode trail lives inside the native header, nothing to reserve.
    this.view.contentEl.toggleClass('eb-active', visible && !this.inHeader);

    // Most scroll frames do not change the chain at all: skip the DOM rebuild
    // when the visible content is identical (same memoization strategy as the
    // sticky-headings reference plugin). Class toggles above always run.
    const renderKey =
      (visible ? crumbs.map(c => `${c.kind}:${c.text}:${c.line ?? ''}:${c.level ?? ''}`).join('|') : '') +
      `#${settings.maxSegmentLength}`;
    if (renderKey === this.lastRenderKey) return;
    this.lastRenderKey = renderKey;

    this.barEl.empty();
    if (!visible) return;

    crumbs.forEach((crumb, index) => {
      // Header mode opens with a separator so the trail reads as continuing
      // the native "Folder › File" path; the standalone bar starts at the edge.
      if (index > 0 || this.inHeader) {
        // Skipped heading levels (issue #1): H1 → H4 renders "›››" between the
        // crumbs — one extra mark per missing level, so the jump is visible.
        // Heading crumbs hang off a virtual root (the file crumb, and the
        // folder chain behind it), treated as level 0: a document that opens
        // with H5 is missing H1-H4 the same way H4 after H1 is missing H2/H3,
        // so the gap shows against the file crumb too. Deepening only — the
        // chain closing upward (H4 → H2) drops crumbs, never adds a gap.
        const prev = crumbs[index - 1];
        const baseLevel = prev?.kind === 'heading' ? (prev.level ?? 1) : 0;
        const gap =
          crumb.kind === 'heading' &&
          typeof crumb.level === 'number'
            ? crumb.level - baseLevel - 1
            : 0;
        const sepCount = 1 + Math.min(Math.max(gap, 0), MAX_SKIP_SEPARATORS);
        this.barEl.createSpan({
          cls: sepCount > 1 ? 'eb-sep eb-sep-skip' : 'eb-sep',
          text: SEPARATOR.repeat(sepCount),
        });
      }
      const el = this.barEl.createSpan({
        cls: `eb-seg eb-seg-${crumb.kind} eb-clickable`,
        text: this.truncate(crumb.text),
        title: crumb.text,
      });
      if (crumb.kind === 'heading') {
        // VS Code style: left click opens the sibling heading menu,
        // right click jumps straight to the crumb.
        el.addEventListener('click', event => {
          this.showSiblingMenu(crumb, event);
        });
        el.addEventListener('contextmenu', event => {
          event.preventDefault();
          event.stopPropagation();
          this.jumpToHeading(crumb);
        });
      } else {
        el.addEventListener('click', () => this.revealInExplorer());
        el.addEventListener('contextmenu', event => {
          event.preventDefault();
          event.stopPropagation();
          this.revealInExplorer();
        });
      }
      if (index === crumbs.length - 1) {
        el.addClass('eb-current');
      }
    });
  }
}
