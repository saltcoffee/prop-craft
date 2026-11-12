import { App, PluginSettingTab, Setting } from 'obsidian';
import type PropCraftPlugin from './main';

export class PropCraftSettingTab extends PluginSettingTab {
  constructor(app: App, private readonly plugin: PropCraftPlugin) {
    super(app, plugin);
  }

  display(): void {
    const { containerEl } = this;
    const t = this.plugin.t;
    containerEl.empty();
    containerEl.createEl('h2', { text: t('settings.title') });

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
}
