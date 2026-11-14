export type PropertyValueType =
  | 'text' | 'list' | 'number' | 'checkbox' | 'date' | 'datetime' | 'mixed' | 'unknown';

export type TagOrigin = 'frontmatter' | 'body' | 'both';

export interface TagPosition {
  /** Absolute character offset in the file. */
  start: number;
  end: number;
}

export interface TagOccurrence {
  /** Raw tag text including the leading '#'. */
  tag: string;
  /** Normalized key: no '#', lowercase, separator-normalized. Used for aggregation. */
  normalized: string;
  origin: TagOrigin;
  /** Body tag occurrence positions (absolute offsets). Empty for frontmatter-only tags. */
  positions: TagPosition[];
}

export interface PropertyValue {
  raw: unknown;
  type: PropertyValueType;
  valueCount: number;
}

export interface FileMeta {
  path: string;
  mtime: number;
  metadataStatus?: 'ready' | 'unavailable';
  tagsComplete?: boolean;
  hasValidFrontmatter: boolean;
  frontmatterParseError: boolean;
  /** Raw frontmatter object (excluding reserved keys handled separately). */
  rawFrontmatter: Record<string, unknown>;
  properties: Record<string, PropertyValue>;
  tags: TagOccurrence[];
}

export interface PropertyStat {
  key: string;
  fileCount: number;
  typeDistribution: Record<PropertyValueType, number>;
  sampleValues: unknown[];
  isReserved: boolean;
  isOrphan: boolean;
  lastModified: number;
}

export interface TagStat {
  /** Raw display tag including '#', case-preserved. Aggregation key. */
  tag: string;
  normalized: string;
  fileCount: number;
  origin: TagOrigin;
  samplePaths: string[];
  duplicateGroupId?: string;
}

export type DuplicateReason = 'case' | 'plural' | 'separator' | 'similarity' | 'synonym';

export interface DuplicateGroup {
  id: string;
  kind: 'tag' | 'property';
  /** Raw members (tags including '#', or property keys). */
  members: string[];
  reason: DuplicateReason[];
  score: number;
  ignored: boolean;
}

export interface SnapshotTotals {
  noteCount: number;
  withFrontmatter: number;
  propertyKeyCount: number;
  tagCount: number;
  orphanCount: number;
  duplicateGroupCount: number;
  parseErrorCount: number;
}

export interface VaultSnapshot {
  revision: number;
  folders: string[];
  generatedAt: number;
  files: Map<string, FileMeta>;
  properties: Map<string, PropertyStat>;
  tags: Map<string, TagStat>;
  duplicateGroups: DuplicateGroup[];
  totals: SnapshotTotals;
}

export type MergeStrategy = 'keep-target' | 'keep-source' | 'merge-list' | 'skip';
export type ConflictStrategy = 'skip' | 'overwrite' | 'append';
export type RegionFormat = 'MDY' | 'DMY' | 'YMD';

export type ChangeOperation =
  | { kind: 'renameProperty'; from: string; to: string }
  | { kind: 'mergeProperty'; from: string; to: string }
  | { kind: 'deleteProperty'; key: string }
  | { kind: 'renameTag'; from: string; to: string }
  | { kind: 'mergeTag'; from: string; to: string }
  | { kind: 'addProperty'; key: string; value: unknown; valueType: PropertyValueType; onConflict: ConflictStrategy }
  | { kind: 'normalizeDate'; key: string; target: 'date' | 'datetime'; regionFormat: RegionFormat };

export interface TextOp {
  start: number;
  end: number;
  expect: string;
  replacement: string;
}

export interface FileChange {
  path: string;
  beforeFrontmatter: Record<string, unknown>;
  afterFrontmatter: Record<string, unknown>;
  textOps: TextOp[];
}

export interface DiffHunk {
  path: string;
  label: string;
  before?: string;
  after?: string;
  kind: 'del' | 'add' | 'ctx';
}
