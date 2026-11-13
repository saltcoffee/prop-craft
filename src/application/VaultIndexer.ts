import type {
  FileMeta, PropertyValue, PropertyValueType, TagOccurrence, VaultSnapshot,
} from '../domain/models';
import { RESERVED_KEYS } from '../constants';
import { normalizeTag } from '../domain/normalize';
import { detectPropertyDuplicates, detectTagDuplicates } from '../domain/similarity';
import type { PropCraftSettings } from '../settings-model';
import type { CachedMeta, VaultPort } from '../ports/VaultPort';
import { shouldExclude } from './exclude';
import type { SnapshotStore } from './SnapshotStore';

export interface IndexerOptions {
  getSettings: () => PropCraftSettings;
  getTypes: () => Map<string, string>;
}

function emptyTypeDistribution(): Record<PropertyValueType, number> {
  return { text: 0, list: 0, number: 0, checkbox: 0, date: 0, datetime: 0, mixed: 0, unknown: 0 };
}

export function emptySnapshot(): VaultSnapshot {
  return {
    generatedAt: Date.now(),
    files: new Map(),
    properties: new Map(),
    tags: new Map(),
    duplicateGroups: [],
    totals: { noteCount: 0, withFrontmatter: 0, propertyKeyCount: 0, tagCount: 0, orphanCount: 0, duplicateGroupCount: 0, parseErrorCount: 0 },
  };
}

function declaredType(typeMap: Map<string, string>, key: string): PropertyValueType | null {
  const value = typeMap.get(key) ?? typeMap.get(key.toLowerCase());
  if (!value) return null;
  const map: Record<string, PropertyValueType> = {
    text: 'text', number: 'number', checkbox: 'checkbox', date: 'date', datetime: 'datetime', multitext: 'list', list: 'list',
  };
  return map[value] ?? null;
}

function inferType(value: unknown): PropertyValueType {
  if (Array.isArray(value)) return 'list';
  if (typeof value === 'number') return 'number';
  if (typeof value === 'boolean') return 'checkbox';
  if (typeof value === 'string') return 'text';
  if (value && typeof value === 'object') return 'unknown';
  return 'unknown';
}

function toPropertyValue(key: string, raw: unknown, typeMap: Map<string, string>): PropertyValue {
  const valueCount = Array.isArray(raw) ? raw.length : 1;
  return { raw, type: declaredType(typeMap, key) ?? inferType(raw), valueCount };
}

function collectTags(cache: CachedMeta | null): TagOccurrence[] {
  const map = new Map<string, TagOccurrence>();
  const add = (raw: string, origin: 'frontmatter' | 'body', position?: { start: number; end: number }) => {
    const tag = raw.startsWith('#') ? raw : `#${raw}`;
    const normalized = normalizeTag(tag);
    if (!normalized) return;
    let occurrence = map.get(tag);
    if (!occurrence) {
      occurrence = { tag, normalized, origin, positions: [] };
      map.set(tag, occurrence);
    } else if (occurrence.origin !== origin) {
      occurrence.origin = 'both';
    }
    if (position) occurrence.positions.push(position);
  };
  const fm = cache?.frontmatter;
  if (fm) {
    for (const key of ['tags', 'tag'] as const) {
      const value = fm[key];
      if (typeof value === 'string') {
        for (const part of value.split(',')) if (part.trim()) add(part.trim(), 'frontmatter');
      } else if (Array.isArray(value)) {
        for (const entry of value) if (typeof entry === 'string' && entry.trim()) add(entry.trim(), 'frontmatter');
      }
    }
  }
  for (const tag of cache?.bodyTags ?? []) add(tag.tag, 'body', { start: tag.start, end: tag.end });
  return [...map.values()];
}

export function extractFileMeta(vault: VaultPort, path: string, typeMap: Map<string, string>): FileMeta {
  const cache = vault.getFileCache(path);
  const fm = cache?.frontmatter;
  const properties: Record<string, PropertyValue> = {};
  if (fm) {
    for (const [key, value] of Object.entries(fm)) {
      if (RESERVED_KEYS.has(key.toLowerCase())) continue;
      properties[key] = toPropertyValue(key, value, typeMap);
    }
  }
  return {
    path,
    mtime: vault.getMtime(path),
    hasValidFrontmatter: Boolean(fm),
    frontmatterParseError: cache?.frontmatterParseError ?? false,
    rawFrontmatter: fm ? { ...fm } : {},
    properties,
    tags: collectTags(cache),
  };
}

function applyAdd(snapshot: VaultSnapshot, meta: FileMeta): void {
  for (const [key, value] of Object.entries(meta.properties)) {
    let stat = snapshot.properties.get(key);
    if (!stat) {
      stat = { key, fileCount: 0, typeDistribution: emptyTypeDistribution(), sampleValues: [], isReserved: false, isOrphan: false, lastModified: 0 };
      snapshot.properties.set(key, stat);
    }
    stat.fileCount += 1;
    stat.typeDistribution[value.type] += 1;
    if (stat.sampleValues.length < 3) stat.sampleValues.push(value.raw);
    if (meta.mtime > stat.lastModified) stat.lastModified = meta.mtime;
  }
  for (const occurrence of meta.tags) {
    let stat = snapshot.tags.get(occurrence.tag);
    if (!stat) {
      stat = { tag: occurrence.tag, normalized: occurrence.normalized, fileCount: 0, origin: occurrence.origin, samplePaths: [] };
      snapshot.tags.set(occurrence.tag, stat);
    }
    stat.fileCount += 1;
    if (stat.samplePaths.length < 3) stat.samplePaths.push(meta.path);
    if (stat.origin === 'both' || occurrence.origin === 'both' || stat.origin !== occurrence.origin) {
      stat.origin = 'both';
    }
  }
}

function applyRemove(snapshot: VaultSnapshot, meta: FileMeta): void {
  for (const [key, value] of Object.entries(meta.properties)) {
    const stat = snapshot.properties.get(key);
    if (!stat) continue;
    stat.fileCount -= 1;
    stat.typeDistribution[value.type] = Math.max(0, stat.typeDistribution[value.type] - 1);
    if (stat.fileCount <= 0) snapshot.properties.delete(key);
  }
  for (const occurrence of meta.tags) {
    const stat = snapshot.tags.get(occurrence.tag);
    if (!stat) continue;
    stat.fileCount -= 1;
    if (stat.fileCount <= 0) snapshot.tags.delete(occurrence.tag);
  }
}

export class VaultIndexer {
  private running = false;
  private pending = false;
  private duplicateTimer: number | null = null;

  constructor(
    private readonly vault: VaultPort,
    private readonly store: SnapshotStore,
    private readonly options: IndexerOptions,
    private readonly chunkSize = 200,
  ) {}

  start(): void {
    void this.runFull();
  }

  stop(): void {
    this.running = false;
    this.pending = false;
    if (this.duplicateTimer) {
      window.clearTimeout(this.duplicateTimer);
      this.duplicateTimer = null;
    }
  }

  async rebuild(): Promise<void> {
    await this.runFull();
  }

  private async runFull(): Promise<void> {
    if (this.running) {
      this.pending = true;
      return;
    }
    this.running = true;
    this.store.setStatus('indexing');
    try {
      const settings = this.options.getSettings();
      const typeMap = this.options.getTypes();
      const snapshot = emptySnapshot();
      const files = this.vault.getMarkdownFiles();
      for (let index = 0; index < files.length; index += 1) {
        if (!this.running) return;
        const file = files[index];
        if (shouldExclude(file.path, settings)) continue;
        const meta = extractFileMeta(this.vault, file.path, typeMap);
        snapshot.files.set(meta.path, meta);
        applyAdd(snapshot, meta);
        if (index % this.chunkSize === 0) await new Promise(resolve => window.setTimeout(resolve, 0));
      }
      this.finalize(snapshot);
      this.store.set(snapshot);
      this.store.setStatus('ready');
    } finally {
      this.running = false;
      if (this.pending) {
        this.pending = false;
        void this.runFull();
      }
    }
  }

  onChanged(path: string): void {
    this.updateOne(path, false);
  }

  onCreated(path: string): void {
    this.updateOne(path, false);
  }

  onDeleted(path: string): void {
    const snapshot = this.store.get();
    if (!snapshot) return;
    const previous = snapshot.files.get(path);
    if (!previous) return;
    applyRemove(snapshot, previous);
    snapshot.files.delete(path);
    this.scheduleFinalize();
  }

  onRenamed(oldPath: string, newPath: string): void {
    this.onDeleted(oldPath);
    this.updateOne(newPath, false);
  }

  private updateOne(path: string, _created: boolean): void {
    if (this.running) return;
    const snapshot = this.store.get();
    if (!snapshot) {
      void this.runFull();
      return;
    }
    const settings = this.options.getSettings();
    const previous = snapshot.files.get(path);
    if (previous) applyRemove(snapshot, previous);
    if (shouldExclude(path, settings)) {
      snapshot.files.delete(path);
      this.scheduleFinalize();
      return;
    }
    const meta = extractFileMeta(this.vault, path, this.options.getTypes());
    snapshot.files.set(path, meta);
    applyAdd(snapshot, meta);
    this.scheduleFinalize();
  }

  private scheduleFinalize(): void {
    const snapshot = this.store.get();
    if (snapshot) this.finalize(snapshot);
    if (this.duplicateTimer) window.clearTimeout(this.duplicateTimer);
    this.duplicateTimer = window.setTimeout(() => {
      const latest = this.store.get();
      if (!latest) return;
      this.finalize(latest);
      this.store.set(latest);
    }, 400);
    this.store.set(snapshot ?? emptySnapshot());
  }

  private finalize(snapshot: VaultSnapshot): void {
    const settings = this.options.getSettings();
    for (const stat of snapshot.properties.values()) {
      stat.isOrphan = !stat.isReserved && stat.fileCount <= settings.orphanThreshold;
    }
    const ignored = new Set(settings.duplicateIgnoreList);
    const tagGroups = detectTagDuplicates([...snapshot.tags.values()], { similarityThreshold: settings.duplicateSimilarityThreshold });
    const propertyGroups = detectPropertyDuplicates([...snapshot.properties.values()], { similarityThreshold: settings.duplicateSimilarityThreshold });
    for (const group of [...tagGroups, ...propertyGroups]) group.ignored = ignored.has(group.id);
    for (const tag of snapshot.tags.values()) tag.duplicateGroupId = undefined;
    for (const stat of snapshot.properties.values()) stat.isReserved = RESERVED_KEYS.has(stat.key.toLowerCase());
    for (const group of tagGroups) {
      if (group.ignored) continue;
      for (const member of group.members) {
        const stat = snapshot.tags.get(member);
        if (stat) stat.duplicateGroupId = group.id;
      }
    }
    snapshot.duplicateGroups = [...tagGroups, ...propertyGroups];
    let withFrontmatter = 0;
    let orphanCount = 0;
    let parseErrorCount = 0;
    for (const meta of snapshot.files.values()) {
      if (meta.hasValidFrontmatter) withFrontmatter += 1;
      if (meta.frontmatterParseError) parseErrorCount += 1;
    }
    for (const stat of snapshot.properties.values()) if (stat.isOrphan) orphanCount += 1;
    snapshot.totals = {
      noteCount: snapshot.files.size,
      withFrontmatter,
      propertyKeyCount: snapshot.properties.size,
      tagCount: snapshot.tags.size,
      orphanCount,
      duplicateGroupCount: snapshot.duplicateGroups.filter(group => !group.ignored).length,
      parseErrorCount,
    };
    snapshot.generatedAt = Date.now();
  }
}
