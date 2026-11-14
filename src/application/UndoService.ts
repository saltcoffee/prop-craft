import { sha256Hex } from '../infrastructure/hash';
import { OperationError, issueCode } from '../domain/errors';
import { hasStarted, type JournalStateV2, type LoadedJournal } from '../domain/journal';
import type { RecoveryItem, RecoveryPreview, RecoveryResult } from '../domain/recovery';
import type { VaultPort } from '../ports/VaultPort';
import type { NoteCodecPort } from '../ports/NoteCodecPort';
import type { PropCraftSettings } from '../settings-model';
import { shouldExclude } from './exclude';
import type { JournalService } from './JournalService';
import type { TypeMigration } from './TypeMigration';
interface RecoverySession { view: RecoveryPreview; current: Map<string, string>; consumed: boolean }

export class UndoService {
  private readonly sessions = new Map<string, RecoverySession>();
  constructor(private readonly vault: VaultPort, private readonly journal: JournalService, private readonly types: TypeMigration, private readonly codec: NoteCodecPort, private readonly getSettings: () => PropCraftSettings) {}
  async preview(transactionId: string): Promise<RecoveryPreview> {
    const loaded = await this.journal.get(transactionId);
    if (loaded.kind !== 'v2' && loaded.kind !== 'legacy') throw new OperationError(loaded.issue);
    const current = new Map<string, string>(), items: RecoveryItem[] = [];
    for (const entry of loaded.transaction.entries) {
      const state = loaded.state?.entries.find(e => e.path === entry.path);
      if (state?.recovery === 'restored') { items.push({ path: entry.path, kind: 'restored', reason: 'restored' }); continue; }
      const legacyEntry = loaded.kind === 'legacy' ? loaded.transaction.entries.find(e => e.path === entry.path) : undefined;
      if (state && ['not-run', 'failed', 'stale'].includes(state.execution) || !state && legacyEntry?.state === 'not-applied') {
        items.push({ path: entry.path, kind: 'not-applied', reason: 'not-run' }); continue;
      }
      try {
        const content = await this.vault.readText(entry.path), hash = await sha256Hex(content);
        const expected = 'expectedAfterHash' in entry ? entry.expectedAfterHash : entry.afterHash;
        if (hash === entry.beforeHash) items.push({ path: entry.path, kind: 'original', reason: 'already-original' });
        else if (this.excluded(entry.path)) items.push({ path: entry.path, kind: 'blocked', reason: 'globally-excluded' });
        else if (expected && hash === expected && (loaded.kind === 'legacy' && (!state || hasStarted(state.execution)) || hasStarted(state?.execution))) {
          items.push({ path: entry.path, kind: 'restore', reason: 'applied' }); current.set(entry.path, content);
        } else items.push({ path: entry.path, kind: 'blocked', reason: !expected || loaded.kind === 'v2' && !hasStarted(state?.execution) ? 'evidence-missing' : 'external-edit' });
      } catch (error) { items.push({ path: entry.path, kind: 'blocked', reason: issueCode(error, 'read-failed') }); }
    }
    let type: RecoveryPreview['type'] = { kind: 'none' };
    if (loaded.kind === 'v2' && loaded.transaction.typePatch) {
      const patch = loaded.transaction.typePatch;
      type = { kind: 'blocked', reason: 'evidence-missing', targetKey: patch.targetKey, value: patch.targetAfter };
      if (!loaded.state && loaded.stateMissing) {
        try { if ((await this.types.inverse(patch)).alreadyOriginal) type = { ...type, kind: 'original', reason: undefined }; }
        catch { /* Missing execution evidence never authorizes a type write. */ }
      } else if (loaded.state?.typeRecovery === 'restored') type.kind = 'original';
      else if (hasStarted(loaded.state?.typeExecution === 'none' ? undefined : loaded.state?.typeExecution)) {
        try {
          const inverse = await this.types.inverse(patch);
          type = { ...type, kind: inverse.alreadyOriginal ? 'original' : 'restore', reason: undefined };
          // Restoring notes in this preview may remove existing dependencies.
          if (!inverse.alreadyOriginal) {
            const projected = new Map(loaded.transaction.entries.filter(entry => items.some(item => item.path === entry.path && (item.kind === 'restore' || item.kind === 'original'))).map(entry => [entry.path, entry.beforeContent]));
            await this.checkDependencies(patch.targetKey, projected);
          }
        } catch (error) { type = { ...type, kind: 'blocked', reason: issueCode(error, 'type-in-use') }; }
      } else if (loaded.state && ['pending', 'not-run', 'failed', 'stale'].includes(loaded.state.typeExecution)) type = { kind: 'none' };
    }
    const view: RecoveryPreview = { id: `rc_${crypto.randomUUID().replace(/-/g, '')}`, revision: 1, transactionId, items, type, legacy: loaded.kind === 'legacy',
      ...(loaded.kind === 'v2' && !loaded.state ? { evidenceIssue: 'evidence-missing' as const,
        canConfirmOriginal: loaded.stateMissing && items.every(item => item.kind === 'original') && (type.kind === 'none' || type.kind === 'original') } : {}) };
    this.sessions.set(view.id, { view, current, consumed: false });
    return structuredClone(view);
  }
  discard(id: string): void { this.sessions.delete(id); }
  private excluded(path: string): boolean { return shouldExclude(path, this.getSettings()); }
  private async checkDependencies(target: string, projected = new Map<string, string>()): Promise<void> {
    // Read-only safety check intentionally includes paths excluded from writes.
    for (const file of this.vault.getMarkdownFiles()) {
      const decoded = this.codec.decode(projected.get(file.path) ?? await this.vault.readText(file.path));
      if (!decoded.ok) throw new OperationError('type-in-use');
      if (Object.keys(decoded.note.frontmatter).some(key => key.toLowerCase() === target)) throw new OperationError('type-in-use');
    }
  }
  private legacyState(loaded: Extract<LoadedJournal, { kind: 'legacy' }>): JournalStateV2 {
    return { schemaVersion: 2, transactionId: loaded.transaction.transactionId, revision: 0, updatedAt: Date.now(), execution: 'partial', recovery: 'none',
      entries: loaded.transaction.entries.map(entry => ({ path: entry.path, execution: entry.state === 'not-applied' ? 'not-run' : entry.afterHash ? 'applied' : 'uncertain', recovery: 'none' })),
      typeExecution: 'none', typeRecovery: 'none' };
  }
  private async confirmOriginal(loaded: Extract<LoadedJournal, { kind: 'v2' }>, session: RecoverySession, signal?: AbortSignal): Promise<RecoveryResult> {
    if (!loaded.stateMissing || !session.view.canConfirmOriginal) throw new OperationError('evidence-missing');
    const items: RecoveryItem[] = [];
    for (const entry of loaded.transaction.entries) {
      if (signal?.aborted) throw new OperationError('cancelled');
      if (await sha256Hex(await this.vault.readText(entry.path)) !== entry.beforeHash) throw new OperationError('external-edit');
      items.push({ path: entry.path, kind: 'original', reason: 'already-original' });
    }
    const patch = loaded.transaction.typePatch;
    if (patch && !(await this.types.inverse(patch)).alreadyOriginal) throw new OperationError('type-config-stale');
    if (signal?.aborted) throw new OperationError('cancelled');
    const transactionId = loaded.transaction.transactionId;
    // Confirm current recovery only; missing execution history remains unknown.
    await this.journal.initializeState(transactionId, { schemaVersion: 2, transactionId, revision: 0, updatedAt: Date.now(), execution: 'interrupted', recovery: 'complete',
      entries: items.map(item => ({ path: item.path, execution: 'uncertain', recovery: 'restored' })),
      typeExecution: patch ? 'uncertain' : 'none', typeRecovery: patch ? 'restored' : 'none' });
    this.sessions.delete(session.view.id); this.journal.release(transactionId);
    return { transactionId, items, complete: true, requiresReconciliation: false };
  }
  async recover(id: string, revision: number, signal?: AbortSignal): Promise<RecoveryResult> {
    const session = this.sessions.get(id);
    if (!session || session.consumed || session.view.revision !== revision) throw new OperationError('plan-invalid');
    session.consumed = true;
    const loaded = await this.journal.get(session.view.transactionId);
    if (loaded.kind !== 'legacy' && loaded.kind !== 'v2') throw new OperationError(loaded.issue);
    if (!loaded.state) {
      if (loaded.kind === 'v2') return this.confirmOriginal(loaded, session, signal);
      await this.journal.initializeState(loaded.transaction.transactionId, this.legacyState(loaded));
    }
    const txId = loaded.transaction.transactionId, items: RecoveryItem[] = [];
    let checkpointFailed = false;
    const save = async (path: string, recovery: JournalStateV2['entries'][number]['recovery'], reason?: JournalStateV2['entries'][number]['reason']) => {
      try { await this.journal.update(txId, state => { const entry = state.entries.find(e => e.path === path)!; entry.recovery = recovery; entry.reason = reason; state.recovery = 'partial'; }); }
      catch { checkpointFailed = true; throw new OperationError('journal-unavailable'); }
    };
    for (const item of session.view.items) {
      if (signal?.aborted || checkpointFailed) { items.push({ ...item, kind: 'blocked', reason: 'cancelled' }); continue; }
      if (item.kind === 'restored' || item.kind === 'not-applied') { items.push(item); continue; }
      const entry = loaded.transaction.entries.find(e => e.path === item.path)!;
      try {
        if (item.kind === 'blocked') { await save(item.path, 'blocked', item.reason); items.push(item); continue; }
        const current = await this.vault.readText(item.path), hash = await sha256Hex(current);
        if (hash === entry.beforeHash) {
          await save(item.path, 'restored'); items.push({ ...item, kind: 'original', reason: 'already-original' }); continue;
        }
        if (this.excluded(item.path)) throw new OperationError('globally-excluded');
        const expected = 'expectedAfterHash' in entry ? entry.expectedAfterHash : entry.afterHash;
        if (!expected || hash !== expected || current !== session.current.get(item.path)) throw new OperationError('external-edit');
        await save(item.path, 'restoring');
        const written = await this.vault.processText(item.path, content => {
          if (this.excluded(item.path)) throw new OperationError('globally-excluded');
          if (content !== current) throw new OperationError('external-edit');
          return entry.beforeContent;
        });
        if (written !== entry.beforeContent) throw new OperationError('write-failed');
        await save(item.path, 'restored');
        items.push({ ...item, kind: 'restored', reason: 'restored' });
      } catch (error) {
        const reason = issueCode(error, 'write-failed');
        items.push({ ...item, kind: 'blocked', reason });
        try { await save(item.path, reason === 'external-edit' || reason === 'globally-excluded' ? 'blocked' : 'uncertain', reason); }
        catch { checkpointFailed = true; }
      }
    }
    let typeReason = session.view.type.reason;
    let typeComplete = session.view.type.kind === 'none' || session.view.type.kind === 'original';
    if (loaded.kind === 'v2' && loaded.transaction.typePatch && !checkpointFailed && !signal?.aborted) {
      const patch = loaded.transaction.typePatch;
      try {
        const current = await this.journal.get(txId);
        if (current.kind !== 'v2' || !current.state) throw new OperationError('evidence-missing');
        if (current.state.typeRecovery === 'restored') {
          typeComplete = true; typeReason = undefined;
        } else if (session.view.type.kind === 'original' || session.view.type.kind === 'restore') {
          if (!hasStarted(current.state.typeExecution === 'none' ? undefined : current.state.typeExecution)) throw new OperationError('evidence-missing');
          const inverse = await this.types.inverse(patch);
          if (!inverse.alreadyOriginal) {
            if (session.view.type.kind === 'original') throw new OperationError('type-config-stale');
            let dependenciesChanged = false;
            const stopWatching = this.vault.watchMarkdownChanges(() => { dependenciesChanged = true; });
            try {
              await this.checkDependencies(patch.targetKey);
              await this.journal.update(txId, state => { state.typeRecovery = 'restoring'; state.recovery = 'partial'; });
              await this.types.restore(patch, () => { if (dependenciesChanged) throw new OperationError('type-in-use'); });
            } finally { stopWatching(); }
          }
          await this.journal.update(txId, state => { state.typeRecovery = 'restored'; state.typeReason = undefined; });
          typeComplete = true; typeReason = undefined;
        } else if (session.view.type.kind === 'blocked') {
          await this.journal.update(txId, state => { state.typeRecovery = 'blocked'; state.typeReason = typeReason; });
        }
      } catch (error) {
        typeReason = issueCode(error, 'type-in-use'); typeComplete = false;
        try { await this.journal.update(txId, state => { state.typeRecovery = 'blocked'; state.typeReason = typeReason; }); } catch { checkpointFailed = true; }
      }
    }
    const complete = !checkpointFailed && typeComplete && items.every(item => item.kind !== 'blocked');
    try {
      await this.journal.update(txId, state => {
        state.recovery = complete ? 'complete' : 'partial';
        if (state.execution === 'prepared' || state.execution === 'running') state.execution = 'interrupted';
      });
    } catch { checkpointFailed = true; }
    this.sessions.delete(id); this.journal.release(txId);
    return { transactionId: txId, items, complete: complete && !checkpointFailed, typeReason, requiresReconciliation: checkpointFailed };
  }
  async reconcile(transactionId: string): Promise<RecoveryPreview> {
    const loaded = await this.journal.get(transactionId);
    if (loaded.kind === 'v2' && loaded.state && loaded.state.recovery !== 'complete') {
      const evidence = new Map<string, { execution?: JournalStateV2['entries'][number]['execution']; recovery?: JournalStateV2['entries'][number]['recovery'] }>();
      for (const entry of loaded.transaction.entries) {
        const state = loaded.state.entries.find(e => e.path === entry.path)!;
        if (state.recovery === 'restored' || !['pending', 'applying', 'uncertain'].includes(state.execution) && !['restoring', 'uncertain'].includes(state.recovery)) continue;
        try {
          const hash = await sha256Hex(await this.vault.readText(entry.path));
          // Once recovery starts, current contents describe recovery, not the original execution result.
          if (state.recovery !== 'none') evidence.set(entry.path, { recovery: hash === entry.beforeHash ? 'restored' : hash === entry.expectedAfterHash ? 'none' : 'blocked' });
          else if (hash === entry.beforeHash) evidence.set(entry.path, { execution: hasStarted(state.execution) ? 'failed' : 'not-run' });
          else if (hash === entry.expectedAfterHash && hasStarted(state.execution)) evidence.set(entry.path, { execution: 'applied' });
          else evidence.set(entry.path, { execution: hasStarted(state.execution) ? 'uncertain' : 'not-run' });
        } catch { evidence.set(entry.path, state.recovery === 'none' ? { execution: 'uncertain' } : { recovery: 'uncertain' }); }
      }
      let typeExecution = loaded.state.typeExecution;
      if (loaded.transaction.typePatch && loaded.state.typeRecovery === 'none' && ['applying', 'uncertain', 'pending'].includes(typeExecution)) {
        try {
          const raw = await this.vault.readConfigFile('types.json');
          typeExecution = raw === loaded.transaction.typePatch.configBeforeContent ? 'not-run'
            : raw === loaded.transaction.typePatch.configAfterContent && typeExecution !== 'pending' ? 'applied' : 'uncertain';
        } catch { typeExecution = 'uncertain'; }
      }
      let typeRecovery = loaded.state.typeRecovery, typeReason = loaded.state.typeReason;
      if (loaded.transaction.typePatch && ['restoring', 'uncertain'].includes(typeRecovery)) {
        try {
          const inverse = await this.types.inverse(loaded.transaction.typePatch);
          typeRecovery = inverse.alreadyOriginal ? 'restored' : 'none'; typeReason = undefined;
        } catch (error) { typeRecovery = 'blocked'; typeReason = issueCode(error, 'type-config-stale'); }
      }
      this.journal.release(transactionId);
      await this.journal.update(transactionId, state => {
        for (const entry of state.entries) Object.assign(entry, evidence.get(entry.path));
        state.typeExecution = typeExecution; state.typeRecovery = typeRecovery; state.typeReason = typeReason;
        const uncertain = state.entries.some(e => e.execution === 'uncertain') || typeExecution === 'uncertain';
        state.execution = uncertain ? 'interrupted' : state.entries.every(e => e.execution === 'applied') ? 'completed' : 'partial';
      });
    }
    return this.preview(transactionId);
  }
}
