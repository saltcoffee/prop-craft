import type { VaultPort } from '../ports/VaultPort';
import type { TypeConfigCodecPort } from '../ports/TypeConfigCodecPort';
import type { ChangeOperation } from '../domain/models';
import { isKnownPropertyType, type TypeDeclarations, type TypePatch } from '../domain/type-config';
import type { TypeSummary } from '../domain/preview';
import { OperationError } from '../domain/errors';
import { sha256Hex } from '../infrastructure/hash';

export class TypeMigration {
  private cached = new Map<string, string>();
  constructor(private readonly vault: VaultPort, private readonly codec: TypeConfigCodecPort) {}
  async loadDeclarations(): Promise<TypeDeclarations> {
    try {
      const raw = await this.vault.readConfigFile('types.json');
      if (raw === null) { this.cached = new Map(); return { kind: 'ready', raw, declarations: this.cached }; }
      const parsed = this.codec.readDeclarations(raw);
      if (!parsed.ok) { this.cached = new Map(); return { kind: 'unsupported', raw }; }
      this.cached = new Map(parsed.value);
      return { kind: 'ready', raw, declarations: new Map(parsed.value) };
    } catch { this.cached = new Map(); return { kind: 'unsupported' }; }
  }
  async load(): Promise<Map<string, string>> { await this.loadDeclarations(); return this.getCached(); }
  getCached(): Map<string, string> { return new Map(this.cached); }
  async plan(operation: ChangeOperation): Promise<{ snapshot: TypeDeclarations; summary: TypeSummary; patch?: TypePatch; targetType?: string; baseline?: string | null }> {
    if (operation.kind === 'renameTag' || operation.kind === 'mergeTag' || operation.kind === 'deleteProperty') return { snapshot: { kind: 'ready', raw: null, declarations: new Map() }, summary: { kind: 'none' } };
    const snapshot = await this.loadDeclarations();
    if (snapshot.kind === 'unsupported') return { snapshot, summary: { kind: 'unsupported' } };
    const targetKey = ('to' in operation ? operation.to : operation.key).toLowerCase();
    const sourceKey = 'from' in operation ? operation.from.toLowerCase() : undefined;
    const existing = snapshot.declarations.get(targetKey);
    if (existing) return { snapshot, targetType: existing, baseline: snapshot.raw, summary: { kind: 'existing', targetKey, sourceKey, type: existing } };
    const sourceType = sourceKey ? snapshot.declarations.get(sourceKey) : undefined;
    if (!sourceKey || !sourceType || snapshot.raw === null) return { snapshot, baseline: snapshot.raw, summary: { kind: 'none', targetKey, sourceKey } };
    if (!isKnownPropertyType(sourceType)) return { snapshot: { kind: 'unsupported' }, summary: { kind: 'unsupported' } };
    const changed = this.codec.addTarget(snapshot.raw, targetKey, sourceType);
    if (!changed.ok) return { snapshot: { kind: 'unsupported' }, summary: { kind: 'unsupported' } };
    const patch: TypePatch = { sourceKey, targetKey, targetAfter: sourceType, configBeforeContent: snapshot.raw, configBeforeHash: await sha256Hex(snapshot.raw), configAfterContent: changed.value, configAfterHash: await sha256Hex(changed.value) };
    return { snapshot, patch, targetType: sourceType, baseline: snapshot.raw, summary: { kind: 'add', targetKey, sourceKey, type: sourceType } };
  }
  async verifyBaseline(raw: string | null | undefined): Promise<void> {
    if (raw !== undefined && await this.vault.readConfigFile('types.json') !== raw) throw new OperationError('type-config-stale');
  }
  async apply(patch: TypePatch): Promise<void> {
    const result = await this.vault.processConfigFile('types.json', current => {
      if (current !== patch.configBeforeContent) throw new OperationError('type-config-stale');
      return patch.configAfterContent;
    });
    if (result !== patch.configAfterContent) throw new OperationError('write-failed');
    await this.loadDeclarations();
  }
  async inverse(patch: TypePatch): Promise<{ before: string; after: string; alreadyOriginal: boolean }> {
    const raw = await this.vault.readConfigFile('types.json');
    if (raw === null) throw new OperationError('type-config-unsupported');
    const parsed = this.codec.readDeclarations(raw);
    if (!parsed.ok) throw new OperationError('type-config-unsupported');
    if (!parsed.value.has(patch.targetKey)) return { before: raw, after: raw, alreadyOriginal: true };
    const inverse = this.codec.removeTarget(raw, patch.targetKey, patch.targetAfter);
    if (!inverse.ok) throw new OperationError('type-config-stale');
    return { before: raw, after: inverse.value, alreadyOriginal: false };
  }
  async restore(patch: TypePatch, assertDependenciesUnchanged: () => void): Promise<void> {
    // Rebuild the key-level inverse at commit time, retaining unrelated newer declarations.
    await this.vault.processConfigFile('types.json', current => {
      const parsed = this.codec.readDeclarations(current);
      if (!parsed.ok) throw new OperationError('type-config-unsupported');
      if (!parsed.value.has(patch.targetKey)) return current;
      const inverse = this.codec.removeTarget(current, patch.targetKey, patch.targetAfter);
      if (!inverse.ok) throw new OperationError('type-config-stale');
      assertDependenciesUnchanged();
      return inverse.value;
    });
    await this.loadDeclarations();
  }
}
