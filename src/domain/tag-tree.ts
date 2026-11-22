import type { FileMeta } from './models';
import type { IssueCode } from './errors';
import { isValidTagPath, splitTagSegments, tagIdentity, tagWithHash } from './normalize';
import { parseFrontmatterTags } from './frontmatter-tags';

export type TagId = string;

export interface TagTreeNode {
  id: TagId;
  displayTag: string;
  rawVariants: readonly string[];
  parentId?: TagId;
  children: readonly TagId[];
  virtual: boolean;
  directPaths: readonly string[];
  branchPaths: readonly string[];
}

export interface TagTreeData {
  effectiveNoteCount: number;
  countedNoteCount: number;
  realTagCount: number;
  unreliablePaths: readonly { path: string; reason: IssueCode }[];
  nodes: ReadonlyMap<TagId, TagTreeNode>;
  rootIds: readonly TagId[];
}

export interface TagTreeView extends TagTreeData {
  requestId: number;
  snapshotRevision: number;
  scopeFingerprint: string;
  settingsFingerprint: string;
  scopeUnknownPaths: readonly string[];
}

interface MutableNode {
  id: TagId;
  parentId?: TagId;
  children: Set<TagId>;
  virtual: boolean;
  rawVariants: Set<string>;
  virtualPrefixes: Set<string>;
  directPaths: Set<string>;
  branchPaths: Set<string>;
}

function compareLex(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/**
 * Stateful accumulator so application services can drive batched, cancellable
 * tag-tree construction without duplicating tree counting logic.
 */
export class TagTreeAccumulator {
  private effectiveNoteCount = 0;
  private countedNoteCount = 0;
  private readonly unreliablePaths: { path: string; reason: IssueCode }[] = [];
  private readonly nodes = new Map<TagId, MutableNode>();
  private readonly rootIds = new Set<TagId>();

  private ensureNode(id: TagId, parentId?: TagId): MutableNode {
    let node = this.nodes.get(id);
    if (!node) {
      node = {
        id,
        parentId,
        children: new Set(),
        virtual: true,
        rawVariants: new Set(),
        virtualPrefixes: new Set(),
        directPaths: new Set(),
        branchPaths: new Set(),
      };
      this.nodes.set(id, node);
      if (parentId !== undefined) {
        const parent = this.nodes.get(parentId);
        if (parent) parent.children.add(id);
      } else {
        this.rootIds.add(id);
      }
    }
    return node;
  }

  addFile(file: FileMeta): void {
    this.effectiveNoteCount++;
    if (file.frontmatterParseError) {
      this.unreliablePaths.push({ path: file.path, reason: 'frontmatter-invalid' });
      return;
    }
    if (file.metadataStatus === 'unavailable') {
      this.unreliablePaths.push({ path: file.path, reason: 'metadata-stale' });
      return;
    }
    const containers = parseFrontmatterTags(file.rawFrontmatter);
    if (!containers.complete) {
      this.unreliablePaths.push({ path: file.path, reason: 'tag-container-unsupported' });
      return;
    }
    if (file.tagsComplete === false) {
      this.unreliablePaths.push({ path: file.path, reason: 'metadata-stale' });
      return;
    }

    this.countedNoteCount++;

    // Collect valid tags from both frontmatter containers and body positions.
    const rawTags = new Set<string>();
    for (const entry of containers.entries) rawTags.add(entry.tag);
    for (const occurrence of file.tags) {
      if (occurrence.positions.length > 0 && isValidTagPath(occurrence.tag)) {
        rawTags.add(tagWithHash(occurrence.tag));
      }
    }

    for (const raw of rawTags) {
      const segments = splitTagSegments(raw);
      if (segments.some(segment => segment.length === 0)) continue;
      let parentId: TagId | undefined;
      for (let depth = 1; depth <= segments.length; depth++) {
        const prefixSegments = segments.slice(0, depth);
        const prefixRaw = `#${prefixSegments.join('/')}`;
        const id = tagIdentity(prefixRaw);
        const node = this.ensureNode(id, parentId);
        node.branchPaths.add(file.path);
        node.virtualPrefixes.add(prefixRaw);
        if (depth === segments.length) {
          node.virtual = false;
          node.directPaths.add(file.path);
          node.rawVariants.add(raw);
        }
        parentId = id;
      }
    }
  }

  finish(): TagTreeData {
    const sortedUnreliable = [...this.unreliablePaths].sort((a, b) => compareLex(a.path, b.path));
    const nodes = new Map<TagId, TagTreeNode>();
    let realTagCount = 0;

    const sortedIds = [...this.nodes.keys()].sort(compareLex);
    for (const id of sortedIds) {
      const entry = this.nodes.get(id)!;
      const rawVariants = [...entry.rawVariants].sort(compareLex);
      const virtualPrefixes = [...entry.virtualPrefixes].sort(compareLex);
      const displayTag = !entry.virtual && rawVariants.length > 0
        ? rawVariants[0]
        : (virtualPrefixes[0] ?? `#${id}`);
      if (!entry.virtual) realTagCount++;
      nodes.set(id, {
        id: entry.id,
        displayTag,
        rawVariants,
        parentId: entry.parentId,
        children: [...entry.children].sort(compareLex),
        virtual: entry.virtual,
        directPaths: [...entry.directPaths].sort(compareLex),
        branchPaths: [...entry.branchPaths].sort(compareLex),
      });
    }

    return {
      effectiveNoteCount: this.effectiveNoteCount,
      countedNoteCount: this.countedNoteCount,
      realTagCount,
      unreliablePaths: sortedUnreliable,
      nodes,
      rootIds: [...this.rootIds].sort(compareLex),
    };
  }
}

/** Build a deterministic identity tag tree from a set of FileMeta records. */
export function buildTagTree(files: readonly FileMeta[]): TagTreeData {
  const accumulator = new TagTreeAccumulator();
  for (const file of files) accumulator.addFile(file);
  return accumulator.finish();
}
