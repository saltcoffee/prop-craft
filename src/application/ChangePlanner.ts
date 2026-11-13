import type {
  ChangeOperation, ChangePlan, ConflictStrategy, FileChange, FileMeta, MergeStrategy, PropertyValueType, RegionFormat, Scope,
} from '../domain/models';
import {
  planAddProperty, planDeleteProperty, planMergeProperty, planMergeTag, planNormalizeDate, planRenameProperty,
} from '../domain/plan';
import { RESERVED_KEYS } from '../constants';
import { tagWithHash } from '../domain/normalize';
import type { PropCraftSettings } from '../settings-model';
import type { VaultPort } from '../ports/VaultPort';
import type { SnapshotStore } from './SnapshotStore';

function newPlanId(): string {
  return `pc_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}

function isReserved(key: string): boolean {
  return RESERVED_KEYS.has(key.toLowerCase());
}

export class ChangePlanner {
  constructor(
    private readonly _vault: VaultPort,
    private readonly store: SnapshotStore,
    private readonly getSettings: () => PropCraftSettings,
  ) {}

  private files(): FileMeta[] {
    const snapshot = this.store.get();
    return snapshot ? [...snapshot.files.values()] : [];
  }

  private scopeFiles(scope: Scope): FileMeta[] {
    const all = this.files();
    if (scope.kind === 'all') return all;
    if (scope.kind === 'files') {
      const set = new Set(scope.paths);
      return all.filter(file => set.has(file.path));
    }
    const folder = scope.path.replace(/^\/+|\/+$/g, '');
    if (!folder) return all;
    return all.filter(file => {
      if (!file.path.startsWith(`${folder}/`)) return false;
      if (scope.includeSubfolders) return true;
      const rest = file.path.slice(folder.length + 1);
      return !rest.includes('/');
    });
  }

  private makePlan(operation: ChangeOperation, changes: FileChange[], skipped = 0): ChangePlan {
    const conflicts = changes.filter(change => change.conflict).length;
    const byType: Record<string, number> = {};
    for (const change of changes) {
      if (change.edits.some(edit => edit.target === 'content')) byType.content = (byType.content ?? 0) + 1;
      if (change.edits.some(edit => edit.target === 'frontmatter')) byType.frontmatter = (byType.frontmatter ?? 0) + 1;
    }
    return {
      id: newPlanId(),
      operation,
      createdAt: Date.now(),
      fileChanges: changes,
      summary: {
        totalFiles: changes.length + skipped,
        willChange: changes.length,
        willSkip: skipped,
        conflicts,
        byType,
      },
    };
  }

  planMergeTag(from: string, to: string): ChangePlan {
    from = tagWithHash(from);
    to = tagWithHash(to);
    const changes: FileChange[] = [];
    for (const file of this.files()) {
      const change = planMergeTag(file, from, to);
      if (change) changes.push(change);
    }
    return this.makePlan({ kind: 'mergeTag', from, to }, changes);
  }

  planRenameTag(from: string, to: string): ChangePlan {
    from = tagWithHash(from);
    to = tagWithHash(to);
    const changes: FileChange[] = [];
    for (const file of this.files()) {
      const change = planMergeTag(file, from, to);
      if (change) changes.push(change);
    }
    return this.makePlan({ kind: 'renameTag', from, to }, changes);
  }

  planMergeProperty(from: string, to: string, strategy: MergeStrategy): ChangePlan {
    if (isReserved(from) || isReserved(to)) return this.makePlan({ kind: 'mergeProperty', from, to, strategy }, []);
    const changes: FileChange[] = [];
    for (const file of this.files()) {
      const change = planMergeProperty(file, from, to, strategy);
      if (change) changes.push(change);
    }
    return this.makePlan({ kind: 'mergeProperty', from, to, strategy }, changes);
  }

  planRenameProperty(from: string, to: string): ChangePlan {
    if (isReserved(from) || isReserved(to)) return this.makePlan({ kind: 'renameProperty', from, to }, []);
    // Renaming onto a key that already exists would silently overwrite its values.
    // Route that case through merge so conflicting values are surfaced in the preview.
    if (this.store.get()?.properties.has(to)) return this.planMergeProperty(from, to, 'merge-list');
    const changes: FileChange[] = [];
    for (const file of this.files()) {
      const change = planRenameProperty(file, from, to);
      if (change) changes.push(change);
    }
    return this.makePlan({ kind: 'renameProperty', from, to }, changes);
  }

  planDeleteProperty(key: string): ChangePlan {
    if (isReserved(key)) return this.makePlan({ kind: 'deleteProperty', key }, []);
    const changes: FileChange[] = [];
    for (const file of this.files()) {
      const change = planDeleteProperty(file, key);
      if (change) changes.push(change);
    }
    return this.makePlan({ kind: 'deleteProperty', key }, changes);
  }

  planAddProperty(scope: Scope, key: string, value: unknown, valueType: PropertyValueType, onConflict: ConflictStrategy): ChangePlan {
    if (isReserved(key)) return this.makePlan({ kind: 'addProperty', key, value, valueType, onConflict }, []);
    const changes: FileChange[] = [];
    let skipped = 0;
    for (const file of this.scopeFiles(scope)) {
      const change = planAddProperty(file, key, value, valueType, onConflict);
      if (change) changes.push(change);
      else skipped += 1;
    }
    return this.makePlan({ kind: 'addProperty', key, value, valueType, onConflict }, changes, skipped);
  }

  planNormalizeDate(key: string, target: 'date' | 'datetime', region: RegionFormat): ChangePlan {
    const settings = this.getSettings();
    const resolvedRegion = region ?? settings.dateRegionFormat;
    const changes: FileChange[] = [];
    let skipped = 0;
    for (const file of this.files()) {
      const value = file.rawFrontmatter[key];
      if (typeof value !== 'string') continue;
      const change = planNormalizeDate(file, key, target, resolvedRegion);
      if (change) changes.push(change);
      else skipped += 1;
    }
    return this.makePlan({ kind: 'normalizeDate', key, target, regionFormat: resolvedRegion }, changes, skipped);
  }
}
