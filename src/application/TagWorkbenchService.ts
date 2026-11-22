import type { VaultSnapshot } from '../domain/models';
import type { ScopeResult } from '../domain/scope';
import { OperationError } from '../domain/errors';
import { TagTreeAccumulator, type TagTreeView } from '../domain/tag-tree';
import type { PropCraftSettings } from '../settings-model';
import { exclusionFingerprint } from './exclude';

const FILE_BATCH_SIZE = 250;
const TOKEN_YIELD_BUDGET = 4000;

export class TagWorkbenchService {
  constructor(private readonly getSettings: () => PropCraftSettings) {}

  async analyze(
    snapshot: VaultSnapshot,
    scope: ScopeResult,
    options: { requestId: number; signal?: AbortSignal },
  ): Promise<TagTreeView> {
    options.signal?.throwIfAborted();
    if (snapshot.revision !== scope.snapshotRevision) throw new OperationError('metadata-stale');
    if (exclusionFingerprint(this.getSettings()) !== scope.settingsFingerprint) throw new OperationError('metadata-stale');

    const accumulator = new TagTreeAccumulator();
    let processedInSlice = 0;
    let tokensInSlice = 0;

    for (const path of scope.effectivePaths) {
      options.signal?.throwIfAborted();
      const file = snapshot.files.get(path);
      if (!file) throw new OperationError('metadata-stale', path);
      accumulator.addFile(file);
      processedInSlice++;
      tokensInSlice += file.tags.reduce((sum, tag) => sum + Math.max(1, tag.positions.length), 0);
      if (processedInSlice >= FILE_BATCH_SIZE || tokensInSlice >= TOKEN_YIELD_BUDGET) {
        processedInSlice = 0;
        tokensInSlice = 0;
        await new Promise<void>(resolve => { window.setTimeout(resolve, 0); });
        options.signal?.throwIfAborted();
      }
    }

    options.signal?.throwIfAborted();
    const data = accumulator.finish();
    return {
      ...data,
      requestId: options.requestId,
      snapshotRevision: snapshot.revision,
      scopeFingerprint: scope.queryFingerprint,
      settingsFingerprint: scope.settingsFingerprint,
      scopeUnknownPaths: [...scope.unknownPaths].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0)),
    };
  }
}
