import { Notice, Plugin, TFile, WorkspaceLeaf, moment } from 'obsidian';
import { VIEW_TYPE_PROP_CRAFT } from './constants';
import { OperationCoordinator } from './application/OperationCoordinator';
import { ScopeService } from './application/ScopeService';
import { ObsidianNoteCodec } from './infrastructure/ObsidianNoteCodec';
import { ObsidianTypeConfigCodec } from './infrastructure/ObsidianTypeConfigCodec';
import { ChangeExecutor } from './application/ChangeExecutor';
import { ChangePlanner } from './application/ChangePlanner';
import { JournalService } from './application/JournalService';
import { SnapshotStore } from './application/SnapshotStore';
import { TypeMigration } from './application/TypeMigration';
import { UndoService } from './application/UndoService';
import { VaultIndexer } from './application/VaultIndexer';
import { ObsidianJournalStore } from './infrastructure/ObsidianJournalStore';
import { ObsidianVaultAdapter } from './infrastructure/ObsidianVaultAdapter';
import { translator, type Translate } from './i18n';
import { DEFAULT_SETTINGS, type PropCraftSettings } from './settings-model';
import { PropCraftSettingTab } from './settings';
import { PropCraftView } from './ui/PropCraftView';
import { confirmAction, promptText } from './ui/PromptModal';

export default class PropCraftPlugin extends Plugin {
  override settings: PropCraftSettings = { ...DEFAULT_SETTINGS };
  t!: Translate;

  store!: SnapshotStore;
  planner!: ChangePlanner;
  journal!: JournalService;
  scopeService!: ScopeService;
  coordinator!: OperationCoordinator;

  private adapter!: ObsidianVaultAdapter;
  private indexer!: VaultIndexer;
  private executor!: ChangeExecutor;
  private undoService!: UndoService;
  private typeMigration!: TypeMigration;

  override async onload(): Promise<void> {
    await this.loadSettings();

    this.adapter = new ObsidianVaultAdapter(this.app);
    this.store = new SnapshotStore();
    const codec = new ObsidianNoteCodec();
    this.typeMigration = new TypeMigration(this.adapter, new ObsidianTypeConfigCodec());
    await this.typeMigration.load();

    this.indexer = new VaultIndexer(this.adapter, this.store, {
      getSettings: () => this.settings,
      getTypes: () => this.typeMigration.getCached(),
    }, codec);
    this.journal = new JournalService(new ObsidianJournalStore(this.adapter), () => this.settings);
    this.planner = new ChangePlanner(this.adapter, this.store, () => this.settings, codec, this.typeMigration);
    this.executor = new ChangeExecutor(this.adapter, this.journal, () => this.settings, this.typeMigration);
    this.undoService = new UndoService(this.adapter, this.journal, this.typeMigration, codec, () => this.settings);

    this.scopeService = new ScopeService(() => this.settings);
    this.coordinator = new OperationCoordinator(this.planner, this.executor, this.journal, this.undoService);
    await this.coordinator.initialize();

    this.t = translator(() => this.language());

    this.registerView(VIEW_TYPE_PROP_CRAFT, (leaf: WorkspaceLeaf) => new PropCraftView(leaf, this));
    this.addRibbonIcon('table', 'PropCraft', () => void this.activateView());

    this.addCommand({ id: 'open', name: this.t('commandOpen'), callback: () => void this.activateView() });
    this.addCommand({ id: 'rebuild-index', name: this.t('commandRebuild'), callback: () => this.reindex() });

    this.addSettingTab(new PropCraftSettingTab(this.app, this));

    this.registerEvent(this.app.vault.on('modify', file => {
      if (file instanceof TFile && file.extension === 'md') this.indexer.onChanged(file.path);
    }));
    this.registerEvent(this.app.vault.on('create', file => {
      if (file instanceof TFile && file.extension === 'md') this.indexer.onCreated(file.path);
    }));
    this.registerEvent(this.app.vault.on('delete', file => {
      if (file instanceof TFile) this.indexer.onDeleted(file.path);
    }));
    this.registerEvent(this.app.vault.on('rename', (file, oldPath) => {
      if (!(file instanceof TFile)) return;
      if (oldPath.toLowerCase().endsWith('.md')) this.indexer.onDeleted(oldPath);
      if (file.extension === 'md') this.indexer.onCreated(file.path);
    }));

    this.app.workspace.onLayoutReady(() => this.indexer.start());
  }

  override onunload(): void {
    this.indexer?.stop();
    this.coordinator?.dispose();
  }

  language(): string {
    if (this.settings.locale === 'zh') return 'zh';
    if (this.settings.locale === 'en') return 'en';
    return moment.locale();
  }

  async loadSettings(): Promise<void> {
    const data = (await this.loadData()) as Partial<PropCraftSettings> | null;
    this.settings = Object.assign({}, DEFAULT_SETTINGS, data ?? {});
  }

  async saveSettings(): Promise<void> {
    await this.saveData(this.settings);
  }

  reindex(): void {
    void this.typeMigration.load()
      .then(() => this.indexer.rebuild())
      .catch(() => undefined);
  }

  notify(message: string): void {
    new Notice(message);
  }

  /** Re-render any open PropCraft view (e.g. after an interface-language change). */
  refreshViews(): void {
    this.store.setStatus(this.store.status());
  }

  prompt(title: string, initial = ''): Promise<string | null> {
    return promptText(this.app, title, initial, this.t('common.apply'), this.t('common.cancel'));
  }

  confirm(message: string): Promise<boolean> {
    return confirmAction(this.app, message, this.t('common.apply'), this.t('common.cancel'));
  }

  ignoreDuplicateGroup(groupId: string): void {
    if (!this.settings.duplicateIgnoreList.includes(groupId)) {
      this.settings.duplicateIgnoreList.push(groupId);
      void this.saveSettings();
      this.reindex();
    }
  }

  async openNote(path: string): Promise<void> {
    await this.app.workspace.openLinkText(path, '', true);
  }

  openSettings(): void {
    // The workspace command opens the native settings UI without writing data.
    const settings = this.app as unknown as { setting?: { open(): void; openTabById(id: string): void } };
    settings.setting?.open();
    settings.setting?.openTabById(this.manifest.id);
  }

  async activateView(): Promise<void> {
    const { workspace } = this.app;
    let leaf = workspace.getLeavesOfType(VIEW_TYPE_PROP_CRAFT)[0];
    if (!leaf) {
      leaf = workspace.getLeaf('tab');
      await leaf.setViewState({ type: VIEW_TYPE_PROP_CRAFT, active: true });
    }
    await workspace.revealLeaf(leaf);
  }
}
