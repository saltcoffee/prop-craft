import type { FileMeta, PropertyValueType, VaultSnapshot } from '../domain/models';
import { detectPropertyDuplicates, detectTagDuplicates } from '../domain/similarity';
import type { PropCraftSettings } from '../settings-model';

export function emptySnapshot(): VaultSnapshot {
  return { revision: 0, folders: [], generatedAt: Date.now(), files: new Map(), properties: new Map(), tags: new Map(), duplicateGroups: [],
    totals: { noteCount: 0, withFrontmatter: 0, propertyKeyCount: 0, tagCount: 0, orphanCount: 0, duplicateGroupCount: 0, parseErrorCount: 0 } };
}
export function aggregateSnapshot(files: readonly FileMeta[], settings: PropCraftSettings, revision: number, folders: string[]): VaultSnapshot {
  const snapshot = emptySnapshot();
  snapshot.revision = revision; snapshot.folders = [...folders];
  for (const meta of files) {
    snapshot.files.set(meta.path, meta);
    if (meta.hasValidFrontmatter) snapshot.totals.withFrontmatter++;
    if (meta.frontmatterParseError || meta.metadataStatus === 'unavailable') snapshot.totals.parseErrorCount++;
    for (const [key, value] of Object.entries(meta.properties)) {
      let stat = snapshot.properties.get(key);
      if (!stat) {
        const typeDistribution: Record<PropertyValueType, number> = { text: 0, list: 0, number: 0, checkbox: 0, date: 0, datetime: 0, mixed: 0, unknown: 0 };
        stat = { key, fileCount: 0, typeDistribution, sampleValues: [], isReserved: false, isOrphan: false, lastModified: 0 };
        snapshot.properties.set(key, stat);
      }
      stat.fileCount++; stat.typeDistribution[value.type]++;
      if (stat.sampleValues.length < 3) stat.sampleValues.push(value.raw);
      stat.lastModified = Math.max(stat.lastModified, meta.mtime);
    }
    for (const tag of meta.tags) {
      let stat = snapshot.tags.get(tag.tag);
      if (!stat) { stat = { tag: tag.tag, normalized: tag.normalized, fileCount: 0, origin: tag.origin, samplePaths: [] }; snapshot.tags.set(tag.tag, stat); }
      stat.fileCount++;
      if (stat.origin !== tag.origin) stat.origin = 'both';
      if (stat.samplePaths.length < 3) stat.samplePaths.push(meta.path);
    }
  }
  for (const stat of snapshot.properties.values()) stat.isOrphan = stat.fileCount <= settings.orphanThreshold;
  const groups = [
    ...detectTagDuplicates([...snapshot.tags.values()], { similarityThreshold: settings.duplicateSimilarityThreshold }),
    ...detectPropertyDuplicates([...snapshot.properties.values()], { similarityThreshold: settings.duplicateSimilarityThreshold }),
  ];
  for (const group of groups) {
    group.ignored = settings.duplicateIgnoreList.includes(group.id);
    if (group.kind === 'tag' && !group.ignored) for (const key of group.members) {
      const stat = snapshot.tags.get(key); if (stat) stat.duplicateGroupId = group.id;
    }
  }
  snapshot.duplicateGroups = groups;
  snapshot.totals.noteCount = files.length;
  snapshot.totals.propertyKeyCount = snapshot.properties.size;
  snapshot.totals.tagCount = snapshot.tags.size;
  snapshot.totals.orphanCount = [...snapshot.properties.values()].filter(stat => stat.isOrphan).length;
  snapshot.totals.duplicateGroupCount = groups.filter(group => !group.ignored).length;
  return snapshot;
}
