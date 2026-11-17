import type { VaultSnapshot } from '../domain/models';
import type { ScopeResult } from '../domain/scope';
import type { PropCraftSettings } from '../settings-model';
import { OperationError } from '../domain/errors';
import { buildDistribution, type DeclarationInfo, type PropertyValueDistribution } from '../domain/value-distribution';
import type { TypeMigration } from './TypeMigration';
import { exclusionFingerprint } from './exclude';

export interface ValueWorkbenchQuery { key: string; mode: 'field' | 'member' }

export class PropertyValueService {
  constructor(private readonly typeMigration: TypeMigration, private readonly getSettings: () => PropCraftSettings) {}

  async analyze(
    snapshot: VaultSnapshot,
    scope: ScopeResult,
    query: ValueWorkbenchQuery,
    options: { requestId: number; signal?: AbortSignal },
  ): Promise<PropertyValueDistribution> {
    options.signal?.throwIfAborted();
    if (!query || typeof query.key !== 'string' || !query.key) throw new OperationError('input-invalid');
    if (query.mode !== 'field' && query.mode !== 'member') throw new OperationError('input-invalid');
    if (snapshot.revision !== scope.snapshotRevision) throw new OperationError('metadata-stale');
    const settings = this.getSettings();
    if (exclusionFingerprint(settings) !== scope.settingsFingerprint) throw new OperationError('metadata-stale');
    let declaration: DeclarationInfo;
    try {
      const declarations = await this.typeMigration.loadDeclarations();
      options.signal?.throwIfAborted();
      if (declarations.kind === 'unsupported') declaration = { kind: 'unavailable' };
      else {
        const type = declarations.declarations.get(query.key.toLowerCase());
        declaration = type ? { kind: 'known', type } : { kind: 'absent' };
      }
    } catch {
      declaration = { kind: 'unavailable' };
    }
    const files = scope.effectivePaths.flatMap(path => {
      const file = snapshot.files.get(path);
      return file ? [file] : [];
    });
    const distribution = buildDistribution({
      requestId: options.requestId,
      snapshotRevision: snapshot.revision,
      scopeFingerprint: scope.queryFingerprint,
      settingsFingerprint: scope.settingsFingerprint,
      key: query.key,
      mode: query.mode,
      declaration,
      files,
      scopeUnknownPaths: scope.unknownPaths,
    });
    options.signal?.throwIfAborted();
    return distribution;
  }
}
