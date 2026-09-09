import { MarkdownView, Menu, TFile, WorkspaceLeaf } from 'obsidian';
import type { BreadcrumbsPlugin } from '../main';
import { Crumb, computeEditHeadingTrail, computePreviewHeadingTrail, getPreviewEl, scrollToPreviewHeading, stripMarkdown } from './trail';

const SEPARATOR = '›';

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

  constructor(plugin: BreadcrumbsPlugin, leaf: WorkspaceLeaf, view: MarkdownView) {
    this.plugin = plugin;
    this.leaf = leaf;
    this.view = view;
    this.barEl = document.createElement('div');
    this.barEl.addClass('eb-bar');

    // Capture-phase scroll listener catches both the CM scroller and the
    // reading-mode preview scroller for this leaf.
    this.scrollHandler = () => this.scheduleRender();
  }

  /** Coalesce scroll-driven and poll-driven renders into a single rAF. */
  private scheduleRender() {
    if (this.rafPending) return;
    this.rafPending = true;
    window.requestAnimationFrame(() => {
      this.rafPending = false;
      this.render();
    });
  }

  mount() {
    const contentEl = this.view.contentEl;
    contentEl.prepend(this.barEl);
    contentEl.addClass('eb-active');
    contentEl.addEventListener('scroll', this.scrollHandler, { capture: true, passive: true });
    // Safety net: scroll restoration at startup and programmatic scrolling in
    // the virtualized reading view do not always dispatch scroll events.
    this.pollTimer = window.setInterval(() => this.checkRefresh(), 1000);
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
      previewEl ? `${Math.round(previewEl.scrollTop)}/${previewEl.scrollHeight}` : '',
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

    if (this.view.getMode() === 'preview') {
      crumbs.push(...computePreviewHeadingTrail(this.plugin.app, this.view));
    } else {
      const cursor = this.view.editor?.getCursor('from');
      const line = cursor ? cursor.line : 0;
      crumbs.push(...computeEditHeadingTrail(this.plugin.app, file, line));
    }

    return crumbs;
  }

  private revealInExplorer(target?: TFile) {
    // internalPlugins is not in the public typings
    const app = this.plugin.app as unknown as {
      internalPlugins?: { getPluginById?: (id: string) => { instance?: unknown } | undefined };
    };
    const fileExplorer = app.internalPlugins?.getPluginById?.('file-explorer');
    const item = target ?? this.view.file ?? this.view.previewMode.file;
    if (!item) return;
    (fileExplorer?.instance as unknown as { revealInFolder?: (f: TFile) => void } | undefined)
      ?.revealInFolder?.(item);
  }

  /**
   * VS Code style sibling menu: lists every heading that shares this crumb's
   * parent (all headings of the same level within the parent's span). The
   * current heading is flagged; picking any entry jumps to it.
   */
  private showSiblingMenu(crumb: Crumb, event: MouseEvent) {
    const file = this.view.file ?? this.view.previewMode.file;
    if (!file || crumb.line == null) return;

    const headings = this.plugin.app.metadataCache.getFileCache(file)?.headings ?? [];
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
    this.view.contentEl.toggleClass('eb-active', visible);

    // Most scroll frames do not change the chain at all: skip the DOM rebuild
    // when the visible content is identical (same memoization strategy as the
    // sticky-headings reference plugin). Class toggles above always run.
    const renderKey =
      (visible ? crumbs.map(c => `${c.kind}:${c.text}:${c.line ?? ''}`).join('|') : '') +
      `#${settings.maxSegmentLength}`;
    if (renderKey === this.lastRenderKey) return;
    this.lastRenderKey = renderKey;

    this.barEl.empty();
    if (!visible) return;

    crumbs.forEach((crumb, index) => {
      if (index > 0) {
        this.barEl.createSpan({ cls: 'eb-sep', text: SEPARATOR });
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
          this.showSiblingMenu(crumb, event as MouseEvent);
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
