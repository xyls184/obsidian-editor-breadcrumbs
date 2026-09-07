import { MarkdownView, Plugin, TFile } from 'obsidian';
import { ViewPlugin, type ViewUpdate } from '@codemirror/view';
import { BreadcrumbBar } from './src/bar';
import { defaultSettings, EBSettings } from './src/settings';
import { EBSettingTab } from './src/settingsTab';

export class BreadcrumbsPlugin extends Plugin {
  settings: EBSettings = defaultSettings;
  bars = new Map<MarkdownView, BreadcrumbBar>();

  async onload() {
    await this.loadSettings();

    this.registerEditorExtension(this.createTracker());
    this.registerEvent(this.app.workspace.on('layout-change', () => this.syncBars()));
    this.registerEvent(
      this.app.workspace.on('active-leaf-change', () => {
        this.syncBars();
        this.renderActive();
      })
    );
    // 'changed' fires promptly per file while typing (as soon as its cache
    // entry is updated), so a freshly typed heading shows up in the bar
    // without waiting for the slower full 'resolve' pass. Both listeners are
    // targeted: only bars actually showing that file re-render.
    this.registerEvent(this.app.metadataCache.on('changed', file => this.renderForFile(file)));
    this.registerEvent(this.app.metadataCache.on('resolve', file => this.renderForFile(file)));

    this.addSettingTab(new EBSettingTab(this.app, this));

    this.app.workspace.onLayoutReady(() => {
      this.syncBars();
    });
  }

  private createTracker() {
    let scheduled = false;
    const scheduleRender = () => {
      if (scheduled) return;
      scheduled = true;
      window.requestAnimationFrame(() => {
        scheduled = false;
        this.renderActive();
      });
    };
    return ViewPlugin.fromClass(
      class {
        // eslint-disable-next-line @typescript-eslint/no-empty-function
        constructor() {}
        update(update: ViewUpdate) {
          if (update.selectionSet || update.docChanged) {
            scheduleRender();
          }
        }
      }
    );
  }

  syncBars() {
    const seen = new Set<MarkdownView>();
    this.app.workspace.iterateAllLeaves(leaf => {
      if (leaf.view instanceof MarkdownView) {
        seen.add(leaf.view);
        if (!this.bars.has(leaf.view)) {
          try {
            const bar = new BreadcrumbBar(this, leaf, leaf.view);
            bar.mount();
            this.bars.set(leaf.view, bar);
          } catch {
            // view may not be ready yet; it will be picked up on the next layout-change
          }
        }
      }
    });
    for (const [view, bar] of this.bars) {
      if (!seen.has(view)) {
        bar.destroy();
        this.bars.delete(view);
      }
    }
    this.renderAll();
  }

  renderAll() {
    for (const bar of this.bars.values()) {
      bar.render();
    }
  }

  /** Re-render only the bars that currently show this file (metadata events). */
  private renderForFile(file: TFile) {
    for (const [view, bar] of this.bars) {
      const barFile = view.file ?? view.previewMode.file;
      if (barFile && barFile.path === file.path) bar.render();
    }
  }

  renderActive() {
    const view = this.app.workspace.getActiveViewOfType(MarkdownView);
    if (!view) return;
    const bar = this.bars.get(view);
    bar?.render();
  }

  onunload() {
    for (const bar of this.bars.values()) {
      bar.destroy();
    }
    this.bars.clear();
  }

  async loadSettings() {
    const settings: EBSettings = { ...defaultSettings, ...((await this.loadData()) as Partial<EBSettings>) };
    // Defensive: a hand-edited or legacy data.json must never produce a
    // non-numeric maxSegmentLength (it would blank every crumb in the bar).
    if (!Number.isFinite(settings.maxSegmentLength) || settings.maxSegmentLength < 0) {
      settings.maxSegmentLength = defaultSettings.maxSegmentLength;
    }
    this.settings = settings;
  }

  async saveSettings() {
    await this.saveData(this.settings);
    for (const bar of this.bars.values()) {
      bar.render();
    }
  }
}

export default BreadcrumbsPlugin;
