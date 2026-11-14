import { App, PluginSettingTab, Setting } from 'obsidian';
import type { SettingDefinitionItem } from 'obsidian';
import type PropCraftPlugin from './main';

export class PropCraftSettingTab extends PluginSettingTab {
  constructor(app: App, private readonly plugin: PropCraftPlugin) {
    super(app, plugin);
  }

  override display(): void {
    const { containerEl } = this;
    const t = this.plugin.t;
    containerEl.empty();
    new Setting(containerEl).setName(t('settings.title')).setHeading();

    new Setting(containerEl)
      .setName(t('settings.language'))
      .setDesc(t('settings.languageDesc'))
      .addDropdown(dropdown => dropdown
        .addOption('auto', t('settings.languageAuto'))
        .addOption('zh', t('settings.languageZh'))
        .addOption('en', t('settings.languageEn'))
        .setValue(this.plugin.settings.locale)
        .onChange(async value => {
          this.plugin.settings.locale = value === 'zh' || value === 'en' ? value : 'auto';
          await this.plugin.saveSettings();
          this.plugin.refreshViews();
          this.display();
        }));

    new Setting(containerEl)
      .setName(t('settings.orphanThreshold'))
      .setDesc(t('settings.orphanThresholdDesc'))
      .addText(text => text
        .setValue(String(this.plugin.settings.orphanThreshold))
        .onChange(async value => {
          this.plugin.settings.orphanThreshold = Math.max(1, Math.floor(Number(value) || 1));
          await this.plugin.saveSettings();
          this.plugin.reindex();
        }));

    new Setting(containerEl)
      .setName(t('settings.similarity'))
      .setDesc(t('settings.similarityDesc'))
      .addText(text => text
        .setValue(String(this.plugin.settings.duplicateSimilarityThreshold))
        .onChange(async value => {
          const parsed = Number(value);
          this.plugin.settings.duplicateSimilarityThreshold = Number.isFinite(parsed) ? Math.min(1, Math.max(0, parsed)) : 0.8;
          await this.plugin.saveSettings();
          this.plugin.reindex();
        }));

    new Setting(containerEl)
      .setName(t('settings.excludeGlobs'))
      .setDesc(t('settings.excludeGlobsDesc'))
      .addTextArea(text => text
        .setValue(this.plugin.settings.excludeGlobs.join('\n'))
        .onChange(async value => {
          this.plugin.settings.excludeGlobs = value.split('\n').map(line => line.trim()).filter(Boolean);
          await this.plugin.saveSettings();
          this.plugin.reindex();
        }));

    new Setting(containerEl)
      .setName(t('settings.templateFolder'))
      .setDesc(t('settings.templateFolderDesc'))
      .addText(text => text
        .setValue(this.plugin.settings.templateFolder)
        .onChange(async value => {
          this.plugin.settings.templateFolder = value.trim();
          await this.plugin.saveSettings();
          this.plugin.reindex();
        }));

    new Setting(containerEl)
      .setName(t('settings.excludeTemplates'))
      .setDesc(t('settings.excludeTemplatesDesc'))
      .addToggle(toggle => toggle
        .setValue(this.plugin.settings.excludeTemplates)
        .onChange(async value => {
          this.plugin.settings.excludeTemplates = value;
          await this.plugin.saveSettings();
          this.plugin.reindex();
        }));

    new Setting(containerEl)
      .setName(t('settings.concurrency'))
      .setDesc(t('settings.concurrencyDesc'))
      .addText(text => text
        .setValue(String(this.plugin.settings.writeConcurrency))
        .onChange(async value => {
          this.plugin.settings.writeConcurrency = Math.min(16, Math.max(1, Math.floor(Number(value) || 8)));
          await this.plugin.saveSettings();
        }));

    new Setting(containerEl)
      .setName(t('settings.journalMax'))
      .setDesc(t('settings.journalMaxDesc'))
      .addText(text => text
        .setValue(String(this.plugin.settings.journalMaxTransactions))
        .onChange(async value => {
          this.plugin.settings.journalMaxTransactions = Math.min(100, Math.max(1, Math.floor(Number(value) || 10)));
          await this.plugin.saveSettings();
        }));

    new Setting(containerEl)
      .setName(t('settings.journalBytes'))
      .setDesc(t('settings.journalBytesDesc'))
      .addText(text => text.setValue(String(this.plugin.settings.journalMaxBytes / (1024 * 1024)))
        .onChange(async value => {
          const amount = Number(value);
          if (!Number.isFinite(amount) || amount <= 0) return;
          this.plugin.settings.journalMaxBytes = Math.ceil(amount * 1024 * 1024);
          await this.plugin.saveSettings();
        }));

    new Setting(containerEl)
      .setName(t('settings.dateRegion'))
      .setDesc(t('settings.dateRegionDesc'))
      .addDropdown(dropdown => dropdown
        .addOption('MDY', 'MM/DD/YYYY')
        .addOption('DMY', 'DD/MM/YYYY')
        .addOption('YMD', 'YYYY/MM/DD')
        .setValue(this.plugin.settings.dateRegionFormat)
        .onChange(async value => {
          this.plugin.settings.dateRegionFormat = value === 'DMY' || value === 'YMD' ? value : 'MDY';
          await this.plugin.saveSettings();
        }));

    new Setting(containerEl)
      .setName(t('settings.debug'))
      .setDesc(t('settings.debugDesc'))
      .addToggle(toggle => toggle
        .setValue(this.plugin.settings.debugLogging)
        .onChange(async value => {
          this.plugin.settings.debugLogging = value;
          await this.plugin.saveSettings();
        }));
  }

  override getSettingDefinitions(): SettingDefinitionItem[] {
    const t = this.plugin.t;
    return [
      { name: t('settings.language'), desc: t('settings.languageDesc'), control: { type: 'dropdown', key: 'locale', options: { auto: t('settings.languageAuto'), zh: t('settings.languageZh'), en: t('settings.languageEn') }, defaultValue: 'auto' } },
      { name: t('settings.orphanThreshold'), desc: t('settings.orphanThresholdDesc'), control: { type: 'number', key: 'orphanThreshold', defaultValue: 1, min: 1, step: 1 } },
      { name: t('settings.similarity'), desc: t('settings.similarityDesc'), control: { type: 'number', key: 'duplicateSimilarityThreshold', defaultValue: 0.8, min: 0, max: 1, step: 0.05 } },
      { name: t('settings.excludeGlobs'), desc: t('settings.excludeGlobsDesc'), control: { type: 'textarea', key: 'excludeGlobs', rows: 4, placeholder: '.trash/**' } },
      { name: t('settings.templateFolder'), desc: t('settings.templateFolderDesc'), control: { type: 'text', key: 'templateFolder' } },
      { name: t('settings.excludeTemplates'), desc: t('settings.excludeTemplatesDesc'), control: { type: 'toggle', key: 'excludeTemplates', defaultValue: true } },
      { name: t('settings.concurrency'), desc: t('settings.concurrencyDesc'), control: { type: 'number', key: 'writeConcurrency', defaultValue: 8, min: 1, max: 16, step: 1 } },
      { name: t('settings.journalMax'), desc: t('settings.journalMaxDesc'), control: { type: 'number', key: 'journalMaxTransactions', defaultValue: 10, min: 1, max: 100, step: 1 } },
      { name: t('settings.journalBytes'), desc: t('settings.journalBytesDesc'), control: { type: 'number', key: 'journalMaxBytes', defaultValue: 50, min: 1, step: 1 } },
      { name: t('settings.dateRegion'), desc: t('settings.dateRegionDesc'), control: { type: 'dropdown', key: 'dateRegionFormat', options: { MDY: 'MM/DD/YYYY', DMY: 'DD/MM/YYYY', YMD: 'YYYY/MM/DD' }, defaultValue: 'MDY' } },
      { name: t('settings.debug'), desc: t('settings.debugDesc'), control: { type: 'toggle', key: 'debugLogging', defaultValue: false } },
    ];
  }

  override getControlValue(key: string): unknown {
    if (key === 'journalMaxBytes') return this.plugin.settings.journalMaxBytes / (1024 * 1024);
    if (key === 'excludeGlobs') return this.plugin.settings.excludeGlobs.join('\n');
    return (this.plugin.settings as unknown as Record<string, unknown>)[key];
  }

  override async setControlValue(key: string, value: unknown): Promise<void> {
    const settings = this.plugin.settings;
    switch (key) {
      case 'excludeGlobs':
        settings.excludeGlobs = String(value).split('\n').map(line => line.trim()).filter(Boolean);
        break;
      case 'orphanThreshold':
        settings.orphanThreshold = Math.max(1, Math.floor(Number(value) || 1));
        break;
      case 'duplicateSimilarityThreshold':
        settings.duplicateSimilarityThreshold = Math.min(1, Math.max(0, Number(value) || 0));
        break;
      case 'writeConcurrency':
        settings.writeConcurrency = Math.min(16, Math.max(1, Math.floor(Number(value) || 8)));
        break;
      case 'journalMaxTransactions':
        settings.journalMaxTransactions = Math.min(100, Math.max(1, Math.floor(Number(value) || 10)));
        break;
      case 'journalMaxBytes': {
        const amount = Number(value);
        if (!Number.isFinite(amount) || amount <= 0) return;
        settings.journalMaxBytes = Math.ceil(amount * 1024 * 1024);
        break;
      }
      case 'locale':
        settings.locale = value === 'zh' || value === 'en' ? value : 'auto';
        break;
      case 'dateRegionFormat':
        settings.dateRegionFormat = value === 'DMY' || value === 'YMD' ? value : 'MDY';
        break;
      case 'excludeTemplates':
        settings.excludeTemplates = Boolean(value);
        break;
      case 'debugLogging':
        settings.debugLogging = Boolean(value);
        break;
      case 'templateFolder':
        settings.templateFolder = String(value).trim();
        break;
      default:
        (settings as unknown as Record<string, unknown>)[key] = value;
    }
    await this.plugin.saveSettings();
    if (key === 'locale') this.plugin.refreshViews();
    else if (['orphanThreshold', 'duplicateSimilarityThreshold', 'excludeGlobs', 'templateFolder', 'excludeTemplates'].includes(key)) this.plugin.reindex();
  }
}
