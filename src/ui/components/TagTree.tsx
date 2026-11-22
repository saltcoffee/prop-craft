import { useMemo, useRef, useState } from 'preact/hooks';
import type { TagId, TagTreeNode, TagTreeView } from '../../domain/tag-tree';
import type { Translate } from '../../i18n';
import type PropCraftPlugin from '../../main';
import { issueText } from '../text';

interface Props {
  tree: TagTreeView;
  search: string;
  selectedIds: ReadonlySet<TagId>;
  canPreview: boolean;
  t: Translate;
  plugin: PropCraftPlugin;
  onClearSearch: () => void;
  onToggleSelect: (id: TagId) => void;
  onDrillDown: (node: TagTreeNode, mode: 'direct' | 'branch') => void;
  onOpenBranchEditor: (fromNode: TagTreeNode, includeDescendants: boolean, targetPrefill?: string) => void;
  onOpenPropertyEditor: (nodes: readonly TagTreeNode[], branchLabel?: string) => void;
}

interface VisibleRow {
  node: TagTreeNode;
  depth: number;
}

function collectBranchRealNodes(tree: TagTreeView, rootId: TagId): TagTreeNode[] {
  const result: TagTreeNode[] = [];
  const visit = (id: TagId) => {
    const node = tree.nodes.get(id);
    if (!node) return;
    if (!node.virtual) result.push(node);
    for (const childId of node.children) visit(childId);
  };
  visit(rootId);
  return result;
}

export function TagTree({
  tree,
  search,
  selectedIds,
  canPreview,
  t,
  plugin,
  onClearSearch,
  onToggleSelect,
  onDrillDown,
  onOpenBranchEditor,
  onOpenPropertyEditor,
}: Props) {
  const [expanded, setExpanded] = useState<Set<TagId>>(() => new Set(tree.rootIds));
  const [activeId, setActiveId] = useState<TagId | null>(null);
  const [dragSourceId, setDragSourceId] = useState<TagId | null>(null);
  const [showUnreliable, setShowUnreliable] = useState(false);
  const rowRefs = useRef(new Map<TagId, HTMLDivElement>());

  const query = search.trim().toLowerCase();

  const matchingIds = useMemo(() => {
    if (!query) return null;
    const matched = new Set<TagId>();
    for (const node of tree.nodes.values()) {
      const hit = node.id.includes(query)
        || node.displayTag.toLowerCase().includes(query)
        || node.rawVariants.some(variant => variant.toLowerCase().includes(query));
      if (hit) {
        let current: TagTreeNode | undefined = node;
        while (current) {
          matched.add(current.id);
          current = current.parentId ? tree.nodes.get(current.parentId) : undefined;
        }
      }
    }
    return matched;
  }, [tree, query]);

  const rows = useMemo(() => {
    const list: VisibleRow[] = [];
    const visit = (id: TagId, depth: number) => {
      if (matchingIds && !matchingIds.has(id)) return;
      const node = tree.nodes.get(id);
      if (!node) return;
      list.push({ node, depth });
      const isExpanded = Boolean(matchingIds) || expanded.has(id);
      if (isExpanded) {
        for (const childId of node.children) visit(childId, depth + 1);
      }
    };
    for (const rootId of tree.rootIds) visit(rootId, 0);
    return list;
  }, [tree, expanded, matchingIds]);

  const toggleExpand = (id: TagId) => {
    setExpanded(current => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  };

  const focusRow = (id: TagId) => {
    setActiveId(id);
    rowRefs.current.get(id)?.focus();
  };

  const onKeyDown = (event: KeyboardEvent, index: number, node: TagTreeNode) => {
    if (event.key === 'ArrowDown') {
      event.preventDefault();
      const next = rows[index + 1];
      if (next) focusRow(next.node.id);
    } else if (event.key === 'ArrowUp') {
      event.preventDefault();
      const prev = rows[index - 1];
      if (prev) focusRow(prev.node.id);
    } else if (event.key === 'Home') {
      event.preventDefault();
      if (rows[0]) focusRow(rows[0].node.id);
    } else if (event.key === 'End') {
      event.preventDefault();
      const last = rows[rows.length - 1];
      if (last) focusRow(last.node.id);
    } else if (event.key === 'ArrowRight' && node.children.length > 0) {
      event.preventDefault();
      if (!expanded.has(node.id) && !matchingIds) {
        toggleExpand(node.id);
      } else {
        const firstChild = rows[index + 1];
        if (firstChild && firstChild.node.parentId === node.id) focusRow(firstChild.node.id);
      }
    } else if (event.key === 'ArrowLeft') {
      event.preventDefault();
      if (node.children.length > 0 && expanded.has(node.id) && !matchingIds) {
        toggleExpand(node.id);
      } else if (node.parentId) {
        focusRow(node.parentId);
      }
    } else if (event.key === 'Enter' && event.target === event.currentTarget) {
      event.preventDefault();
      if (!node.virtual) onToggleSelect(node.id);
      else if (node.children.length > 0) toggleExpand(node.id);
    }
  };

  return (
    <div class="propcraft-tag-tree-wrap">
      <div class="propcraft-muted" role="status" aria-live="polite">
        {t('tags.tree.summary', {
          realTags: tree.realTagCount,
          counted: tree.countedNoteCount,
          effective: tree.effectiveNoteCount,
          unreliable: tree.unreliablePaths.length,
          unknown: tree.scopeUnknownPaths.length,
        })}
      </div>

      {query ? <div class="propcraft-muted">{t('tags.tree.searchHint')}</div> : null}

      {tree.unreliablePaths.length > 0 ? (
        <div class="propcraft-group">
          <button class="propcraft-link" onClick={() => setShowUnreliable(value => !value)}>
            {t('tags.tree.unreliableTitle', { count: tree.unreliablePaths.length })}
          </button>
          {showUnreliable ? (
            <div class="propcraft-failed">
              <ul>
                {tree.unreliablePaths.map(item => (
                  <li key={item.path}>
                    <span class="propcraft-path">{item.path}</span> — {issueText(t, item.reason)}{' '}
                    <button class="propcraft-link" onClick={() => void plugin.openNote(item.path)}>{t('scope.open')}</button>
                  </li>
                ))}
              </ul>
            </div>
          ) : null}
        </div>
      ) : null}

      {tree.effectiveNoteCount === 0 ? (
        <div class="propcraft-empty">{t('tags.tree.noScopeNotes')}</div>
      ) : tree.nodes.size === 0 ? (
        <div class="propcraft-empty">{t('tags.tree.noTags')}</div>
      ) : rows.length === 0 ? (
        <div class="propcraft-empty">
          <div>{t('tags.tree.noSearchMatch', { query: search })}</div>
          <button class="propcraft-btn" onClick={onClearSearch}>{t('tags.tree.clearSearch')}</button>
        </div>
      ) : (
        <div class="propcraft-tag-tree" role="tree">
          {rows.map(({ node, depth }, index) => {
            const hasChildren = node.children.length > 0;
            const isExpanded = Boolean(matchingIds) || expanded.has(node.id);
            const isActive = activeId === node.id || (activeId === null && index === 0);
            return (
              <div
                key={node.id}
                ref={el => { if (el) rowRefs.current.set(node.id, el); else rowRefs.current.delete(node.id); }}
                role="treeitem"
                aria-level={depth + 1}
                aria-expanded={hasChildren ? isExpanded : undefined}
                aria-selected={!node.virtual ? selectedIds.has(node.id) : undefined}
                tabIndex={isActive ? 0 : -1}
                class={`propcraft-tree-row ${node.virtual ? 'is-virtual' : ''} ${dragSourceId === node.id ? 'is-dragging' : ''}`}
                style={{ paddingInlineStart: `${8 + depth * 18}px` }}
                draggable={canPreview}
                onFocus={() => setActiveId(node.id)}
                onKeyDown={event => onKeyDown(event, index, node)}
                onDragStart={() => setDragSourceId(node.id)}
                onDragEnd={() => setDragSourceId(null)}
                onDragOver={event => { if (canPreview) event.preventDefault(); }}
                onDrop={event => {
                  event.preventDefault();
                  if (dragSourceId && dragSourceId !== node.id) {
                    const sourceNode = tree.nodes.get(dragSourceId);
                    if (sourceNode) {
                      onOpenBranchEditor(sourceNode, sourceNode.virtual, node.displayTag);
                    }
                  }
                  setDragSourceId(null);
                }}
              >
                <div class="propcraft-tree-main">
                  {hasChildren ? (
                    <button
                      type="button"
                      class="propcraft-tree-toggle"
                      aria-label={t(isExpanded ? 'tags.tree.collapse' : 'tags.tree.expand', { tag: node.displayTag })}
                      onClick={() => toggleExpand(node.id)}
                    >
                      {isExpanded ? '▾' : '▸'}
                    </button>
                  ) : <span class="propcraft-tree-spacer" aria-hidden="true" />}

                  {!node.virtual ? (
                    <input
                      type="checkbox"
                      checked={selectedIds.has(node.id)}
                      onChange={() => onToggleSelect(node.id)}
                    />
                  ) : null}

                  <span class="propcraft-tree-name propcraft-path">{node.displayTag}</span>
                  <span
                    class={`propcraft-badge ${node.virtual ? 'mod-warn' : ''}`}
                    title={node.virtual ? t('tags.tree.virtualHint') : undefined}
                  >
                    {t(node.virtual ? 'tags.tree.virtual' : 'tags.tree.real')}
                  </span>

                  {node.rawVariants.length > 1 ? (
                    <span class="propcraft-muted propcraft-tree-variants">
                      {t('tags.tree.variants', { variants: node.rawVariants.join(', ') })}
                    </span>
                  ) : null}
                </div>

                <div class="propcraft-tree-meta">
                  <button
                    type="button"
                    class="propcraft-link"
                    disabled={node.directPaths.length === 0}
                    onClick={() => onDrillDown(node, 'direct')}
                  >
                    {t('tags.tree.direct', { count: node.directPaths.length })}
                  </button>
                  <button
                    type="button"
                    class="propcraft-link"
                    disabled={node.branchPaths.length === 0}
                    onClick={() => onDrillDown(node, 'branch')}
                  >
                    {t('tags.tree.branch', { count: node.branchPaths.length })}
                  </button>
                </div>

                <div class="propcraft-actions">
                  {!node.virtual ? (
                    <button type="button" class="propcraft-link" disabled={!canPreview} onClick={() => onOpenBranchEditor(node, false)}>
                      {t('tags.action.renameExact')}
                    </button>
                  ) : null}
                  <button type="button" class="propcraft-link" disabled={!canPreview} onClick={() => onOpenBranchEditor(node, true)}>
                    {t('tags.action.migrateBranch')}
                  </button>
                  {!node.virtual ? (
                    <button type="button" class="propcraft-link" disabled={!canPreview} onClick={() => onOpenPropertyEditor([node])}>
                      {t('tags.action.toProperty')}
                    </button>
                  ) : (
                    <button
                      type="button"
                      class="propcraft-link"
                      disabled={!canPreview}
                      onClick={() => onOpenPropertyEditor(collectBranchRealNodes(tree, node.id), node.displayTag)}
                    >
                      {t('tags.action.selectBranchReal')}
                    </button>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
