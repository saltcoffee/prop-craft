import type { VaultSnapshot } from '../domain/models';
import { inBase, matchScope, validateScope, type ScopeQuery, type ScopeResult } from '../domain/scope';
import type { PropCraftSettings } from '../settings-model';
import { exclusionFingerprint, shouldExclude } from './exclude';
import { aggregateSnapshot } from './snapshot';

export class ScopeService {
  constructor(private readonly getSettings: () => PropCraftSettings) {}
  async evaluate(query: ScopeQuery, snapshot: VaultSnapshot, options: { requestId: number; signal?: AbortSignal }): Promise<ScopeResult> {
    query = validateScope(query, snapshot.folders);
    const settings = structuredClone(this.getSettings());
    const result: ScopeResult = { requestId: options.requestId, snapshotRevision: snapshot.revision, queryFingerprint: JSON.stringify(query), settingsFingerprint: exclusionFingerprint(settings),
      candidatePaths: [], matchedPaths: [], noMatchPaths: [], unknownPaths: [], globallyExcludedPaths: [], manuallyExcludedPaths: [], effectivePaths: [], reasons: Object.create(null) as ScopeResult['reasons'],
      summary: { base: query.base, conditions: query.conditions, matched: 0, manual: 0, effective: 0, unknown: 0 } };
    const manual = new Set(query.manuallyExcludedPaths);
    const files = [...snapshot.files.values()].sort((a, b) => a.path.localeCompare(b.path));
    for (let i = 0; i < files.length; i++) {
      options.signal?.throwIfAborted();
      const file = files[i], path = file.path;
      if (shouldExclude(path, settings)) result.globallyExcludedPaths.push(path);
      else if (inBase(path, query.base)) {
        result.candidatePaths.push(path);
        const match = matchScope(file, query);
        if (match === 'match') {
          result.matchedPaths.push(path);
          if (manual.has(path)) result.manuallyExcludedPaths.push(path); else result.effectivePaths.push(path);
        } else if (match === 'no-match') result.noMatchPaths.push(path);
        else {
          result.unknownPaths.push(path);
          result.reasons[path] = file.frontmatterParseError ? 'frontmatter-invalid' : 'metadata-stale';
        }
      }
      if (i > 0 && i % 1000 === 0) await new Promise(resolve => setTimeout(resolve, 0));
    }
    result.summary = { ...result.summary, matched: result.matchedPaths.length, manual: result.manuallyExcludedPaths.length, effective: result.effectivePaths.length, unknown: result.unknownPaths.length };
    return result;
  }
  aggregate(snapshot: VaultSnapshot, scope: ScopeResult): VaultSnapshot {
    return aggregateSnapshot(scope.effectivePaths.flatMap(path => { const file = snapshot.files.get(path); return file ? [file] : []; }), this.getSettings(), snapshot.revision, snapshot.folders);
  }
}
