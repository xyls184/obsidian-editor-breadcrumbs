import { App, PluginSettingTab, Setting } from 'obsidian';
import type BreadcrumbsPlugin from '../main';

export class EBSettingTab extends PluginSettingTab {
  plugin: BreadcrumbsPlugin;

  constructor(app: App, plugin: BreadcrumbsPlugin) {
    super(app, plugin);
    this.plugin = plugin;
  }

  display(): void {
    const { containerEl } = this;
    containerEl.empty();

    new Setting(containerEl)
      .setName('Show folder path')
      .setDesc('Show the folder chain (Folder › Subfolder) before the file name.')
      .addToggle(toggle =>
        toggle.setValue(this.plugin.settings.showFolderPath).onChange(async value => {
          this.plugin.settings.showFolderPath = value;
          await this.plugin.saveSettings();
        })
      );

    new Setting(containerEl)
      .setName('Show file name')
      .setDesc('Show the current file name as a crumb.')
      .addToggle(toggle =>
        toggle.setValue(this.plugin.settings.showFileName).onChange(async value => {
          this.plugin.settings.showFileName = value;
          await this.plugin.saveSettings();
        })
      );

    new Setting(containerEl)
      .setName('Max characters per crumb')
      .setDesc('Longer names are truncated with an ellipsis (…).')
      .addText(text =>
        text
          .setValue(String(this.plugin.settings.maxSegmentLength))
          .onChange(async value => {
            const parsed = parseInt(value, 10);
            if (!Number.isNaN(parsed) && parsed > 0) {
              this.plugin.settings.maxSegmentLength = parsed;
              await this.plugin.saveSettings();
            }
          })
      );

    new Setting(containerEl)
      .setName('Show in reading mode')
      .setDesc('Also show the breadcrumb bar in reading (preview) mode, following the scroll position.')
      .addToggle(toggle =>
        toggle.setValue(this.plugin.settings.showInReadingMode).onChange(async value => {
          this.plugin.settings.showInReadingMode = value;
          await this.plugin.saveSettings();
        })
      );

    new Setting(containerEl)
      .setName('Hide when there are no headings')
      .setDesc('Hide the bar completely for notes without any headings.')
      .addToggle(toggle =>
        toggle.setValue(this.plugin.settings.hideWhenNoHeadings).onChange(async value => {
          this.plugin.settings.hideWhenNoHeadings = value;
          await this.plugin.saveSettings();
        })
      );
  }
}
