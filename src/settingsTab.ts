import { App, PluginSettingTab, SettingDefinitionItem } from 'obsidian';
import type BreadcrumbsPlugin from '../main';
import { defaultSettings } from './settings';

export class EBSettingTab extends PluginSettingTab {
  plugin: BreadcrumbsPlugin;

  constructor(app: App, plugin: BreadcrumbsPlugin) {
    super(app, plugin);
    this.plugin = plugin;
  }

  getSettingDefinitions(): SettingDefinitionItem[] {
    return [
      {
        name: 'Show folder path',
        desc: 'Show the folder chain (Folder › Subfolder) before the file name.',
        control: { type: 'toggle', key: 'showFolderPath' },
      },
      {
        name: 'Show file name',
        desc: 'Show the current file name as a crumb.',
        control: { type: 'toggle', key: 'showFileName' },
      },
      {
        name: 'Max characters per crumb',
        desc: 'Longer names are truncated with an ellipsis (…).',
        control: {
          type: 'number',
          key: 'maxSegmentLength',
          min: 1,
          step: 1,
          defaultValue: defaultSettings.maxSegmentLength,
          validate: value => (value >= 1 ? undefined : 'Enter a number of at least 1.'),
        },
      },
      {
        name: 'Show in reading mode',
        desc: 'Also show the breadcrumb bar in reading (preview) mode, following the scroll position.',
        control: { type: 'toggle', key: 'showInReadingMode' },
      },
      {
        name: 'Hide when there are no headings',
        desc: 'Hide the bar completely for notes without any headings.',
        control: { type: 'toggle', key: 'hideWhenNoHeadings' },
      },
    ];
  }

  /** The base implementation persists to `plugin.settings`; refresh the bars on top of that. */
  override async setControlValue(key: string, value: unknown): Promise<void> {
    await super.setControlValue(key, value);
    this.plugin.renderAll();
  }
}
