import { decodeJournal, decodeState, utf8Bytes, validJournalId, type JournalStateV2, type JournalTransactionV2, type LoadedJournal } from '../domain/journal';
import { isVaultPath } from '../domain/scope';
import { OperationError } from '../domain/errors';
import type { JournalStore, StoredJournal } from '../ports/JournalStore';
import type { VaultPort } from '../ports/VaultPort';
import { ObsidianTypeConfigCodec } from './ObsidianTypeConfigCodec';
import { isKnownPropertyType } from '../domain/type-config';
import { sha256Hex } from './hash';
const JOURNAL_DIR = 'plugins/propcraft/journal';

export class ObsidianJournalStore implements JournalStore {
  constructor(private readonly vault: VaultPort) {}
  private path(id: string, file?: string): string {
    if (!validJournalId(id)) throw new OperationError('journal-invalid');
    return `${JOURNAL_DIR}/${id}${file ? `/${file}.json` : '.json'}`;
  }
  async prepare(transaction: JournalTransactionV2, state: JournalStateV2): Promise<void> {
    const id = transaction.transactionId;
    if (await this.vault.readConfigFile(this.path(id, 'transaction')) !== null || await this.vault.readConfigFile(this.path(id)) !== null) throw new OperationError('journal-invalid');
    await this.vault.writeConfigFile(this.path(id, 'transaction'), JSON.stringify(transaction));
    await this.vault.writeConfigFile(this.path(id, 'state'), JSON.stringify(state));
  }
  async checkpoint(id: string, expectedRevision: number, next: JournalStateV2): Promise<void> {
    const raw = JSON.stringify(next), relative = this.path(id, 'state');
    const result = await this.vault.processConfigFile(relative, current => {
      const previous = decodeState(current, id, next.entries.map(entry => entry.path));
      if (!previous || previous.revision !== expectedRevision || next.revision !== expectedRevision + 1) throw new OperationError('journal-invalid');
      return raw;
    });
    if (result !== raw || await this.vault.readConfigFile(relative) !== raw) throw new OperationError('journal-unavailable');
  }
  async initializeState(id: string, next: JournalStateV2): Promise<void> {
    const path = this.path(id, 'state');
    const old = await this.vault.readConfigFile(path);
    // Never replace a damaged state file with invented execution evidence.
    if (old !== null) throw new OperationError('evidence-missing');
    const raw = JSON.stringify(next);
    await this.vault.writeConfigFile(path, raw);
    if (await this.vault.readConfigFile(path) !== raw) throw new OperationError('journal-unavailable');
  }
  private async read(id: string): Promise<{ loaded: LoadedJournal; bytes: number; reservedBytes: number }> {
    const material = await this.vault.readConfigFile(this.path(id, 'transaction'));
    const legacy = material === null ? await this.vault.readConfigFile(this.path(id)) : null;
    const stateRaw = await this.vault.readConfigFile(this.path(id, 'state'));
    let loaded = await decodeJournal(material ?? legacy, stateRaw, id, sha256Hex);
    if (loaded.kind === 'v2' && loaded.transaction.typePatch) {
      const patch = loaded.transaction.typePatch, codec = new ObsidianTypeConfigCodec();
      const source = codec.readDeclarations(patch.configBeforeContent);
      const added = codec.addTarget(patch.configBeforeContent, patch.targetKey, patch.targetAfter);
      if (!patch.targetKey || patch.targetKey !== patch.targetKey.toLowerCase() || patch.sourceKey !== patch.sourceKey.toLowerCase()
        || !isKnownPropertyType(patch.targetAfter) || !source.ok || source.value.get(patch.sourceKey) !== patch.targetAfter
        || !added.ok || added.value !== patch.configAfterContent) loaded = { kind: 'invalid', transactionId: id, issue: 'journal-invalid' };
    }
    const bytes = utf8Bytes(material ?? legacy ?? '') + utf8Bytes(stateRaw ?? '');
    const reservedBytes = loaded.kind === 'v2' ? utf8Bytes(material!) + Math.max(loaded.transaction.stateBudgetBytes, utf8Bytes(stateRaw ?? '')) : bytes;
    return { loaded, bytes, reservedBytes };
  }
  async load(id: string): Promise<LoadedJournal> { return (await this.read(id)).loaded; }
  async list(): Promise<StoredJournal[]> {
    const paths = await this.vault.listConfigDir(JOURNAL_DIR), ids = new Set<string>();
    const results: StoredJournal[] = [];
    for (const path of paths) {
      const name = path.slice(JOURNAL_DIR.length + 1);
      const id = name.endsWith('.json') ? name.slice(0, -5) : name;
      if (!validJournalId(id)) {
        if (!isVaultPath(name) || name.includes('/')) throw new OperationError('journal-invalid');
        let bytes = 0;
        if (name.endsWith('.json')) bytes = utf8Bytes(await this.vault.readConfigFile(`${JOURNAL_DIR}/${name}`) ?? '');
        else {
          for (const file of await this.vault.listConfigDir(`${JOURNAL_DIR}/${name}`)) bytes += utf8Bytes(await this.vault.readConfigFile(file) ?? '');
        }
        results.push({ id: name, loaded: { kind: 'invalid', transactionId: name, issue: 'journal-invalid' }, bytes, reservedBytes: bytes });
        continue;
      }
      if (!name.endsWith('.json') && (await this.vault.listConfigDir(`${JOURNAL_DIR}/${name}`)).length === 0) continue;
      ids.add(id);
    }
    for (const id of ids) results.push({ id, ...await this.read(id) });
    return results;
  }
  async removeOne(id: string): Promise<void> {
    // Explicit file paths only; never recursively remove the journal directory.
    await this.vault.removeConfigFile(this.path(id, 'state'));
    await this.vault.removeConfigFile(this.path(id, 'transaction'));
    await this.vault.removeConfigFile(this.path(id));
  }
}
