import { useEffect, useRef, useState } from 'preact/hooks';
import type { DuplicateGroup, DuplicateReason, TagStat } from '../../domain/models';
import type { TagId, TagTreeNode, TagTreeView } from '../../domain/tag-tree';
import type { TextKey } from '../../i18n';
import { tagIdentity, tagWithHash } from '../../domain/normalize';
import { TagTree } from '../components/TagTree';
import { TagNoteList } from '../components/TagNoteList';
import { TagBranchEditor } from '../components/TagBranchEditor';
import { TagPropertyEditor } from '../components/TagPropertyEditor';
import type { PageProps } from '../types';

const REASON_LABEL: Record<DuplicateReason, TextKey> = {
  case: 'reason.case',
  plural: 'reason.plural',
  separator: 'reason.separator',
  similarity: 'reason.similarity',
  synonym: 'reason.synonym',
};

function originLabel(t: PageProps['t'], origin: TagStat['origin']): string {
  if (origin === 'frontmatter') return t('tags.origin.frontmatter');
  if (origin === 'body') return t('tags.origin.body');
  return t('tags.origin.both');
}

export function TagGrid({ snapshot, sourceSnapshot, scope, t, plugin, requestPreview, canPreview }: PageProps) {
  const [viewMode, setViewMode] = useState<'tree' | 'list'>('tree');
  const [search, setSearch] = useState('');
  const [duplicatesOnly, setDuplicatesOnly] = useState(false);
  const [dragFrom, setDragFrom] = useState<string | null>(null);
  const [tree, setTree] = useState<TagTreeView | null>(null);
  const [treeBusy, setTreeBusy] = useState(false);
  const [selectedIds, setSelectedIds] = useState<Set<TagId>>(new Set());
  const [drillDown, setDrillDown] = useState<{ title: string; paths: readonly string[] } | null>(null);
  const [branchEditor, setBranchEditor] = useState<{ node: TagTreeNode; includeDescendants: boolean; targetPrefill?: string } | null>(null);
  const [propertyEditor, setPropertyEditor] = useState<{ nodes: readonly TagTreeNode[]; branchLabel?: string } | null>(null);
  const treeRequest = useRef(0);

  useEffect(() => {
    if (!sourceSnapshot || !scope || sourceSnapshot.revision !== scope.snapshotRevision) {
      setTree(null);
      return;
    }
    const abort = new AbortController();
    const requestId = ++treeRequest.current;
    setTreeBusy(true);
    void plugin.tagWorkbenchService.analyze(sourceSnapshot, scope, { requestId, signal: abort.signal }).then(result => {
      if (abort.signal.aborted || requestId !== treeRequest.current) return;
      setTree(result);
      setSelectedIds(current => {
        const next = new Set<TagId>();
        for (const id of current) {
          const node = result.nodes.get(id);
          if (node && !node.virtual) next.add(id);
        }
        return next;
      });
      setTreeBusy(false);
    }).catch(() => {
      if (!abort.signal.aborted && requestId === treeRequest.current) setTreeBusy(false);
    });
    return () => { abort.abort(); };
  }, [sourceSnapshot, scope, plugin]);

  if (!snapshot) return <div class="propcraft-empty">{t('notice.indexing')}</div>;

  const fallbackTree = (): TagTreeView => ({
    requestId: 0,
    snapshotRevision: snapshot.revision,
    scopeFingerprint: scope?.queryFingerprint ?? '',
    settingsFingerprint: scope?.settingsFingerprint ?? '',
    effectiveNoteCount: snapshot.totals.noteCount,
    countedNoteCount: snapshot.totals.noteCount,
    realTagCount: snapshot.tags.size,
    unreliablePaths: [],
    scopeUnknownPaths: scope?.unknownPaths ?? [],
    nodes: new Map(),
    rootIds: [],
  });

  const openExactEditor = (from: string, targetPrefill?: string) => {
    if (!canPreview) return;
    const normalized = tagWithHash(from);
    const id = tagIdentity(normalized);
    const existing = tree?.nodes.get(id);
    const node: TagTreeNode = existing && !existing.virtual
      ? existing
      : {
        id,
        displayTag: normalized,
        rawVariants: [normalized],
        children: [],
        virtual: false,
        directPaths: snapshot.tags.get(normalized)?.samplePaths ?? [],
        branchPaths: snapshot.tags.get(normalized)?.samplePaths ?? [],
      };
    setBranchEditor({
      node,
      includeDescendants: false,
      targetPrefill: targetPrefill === undefined ? normalized : targetPrefill ? tagWithHash(targetPrefill) : '',
    });
  };

  const toggleSelect = (id: TagId) => {
    setSelectedIds(current => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  };

  const selectedNodes = tree
    ? [...selectedIds].map(id => tree.nodes.get(id)).filter((node): node is TagTreeNode => Boolean(node && !node.virtual))
    : [];

  const tagGroups = snapshot.duplicateGroups.filter(group => group.kind === 'tag' && !group.ignored);
  const tags = [...snapshot.tags.values()]
    .filter(tag => (duplicatesOnly ? Boolean(tag.duplicateGroupId) : true))
    .filter(tag => tag.tag.toLowerCase().includes(search.toLowerCase()))
    .sort((a, b) => b.fileCount - a.fileCount || a.tag.localeCompare(b.tag));

  const renderCard = (stat: TagStat) => (
    <div
      key={stat.tag}
      class={`propcraft-tagcard ${dragFrom === stat.tag ? 'is-dragging' : ''}`}
      draggable
      onDragStart={() => setDragFrom(stat.tag)}
      onDragEnd={() => setDragFrom(null)}
      onDragOver={event => event.preventDefault()}
      onDrop={event => {
        event.preventDefault();
        if (dragFrom && dragFrom !== stat.tag) openExactEditor(dragFrom, stat.tag);
        setDragFrom(null);
      }}
      title={t('tags.mergeHint')}
    >
      <span class="propcraft-tagcard-name">{stat.tag}</span>
      <span class="propcraft-tagcard-count">{stat.fileCount}</span>
    </div>
  );

  const renderGroup = (group: DuplicateGroup) => (
    <div class="propcraft-group" key={group.id}>
      <div class="propcraft-group-head">
        <span>{t('tags.group')} · {group.reason.map(reason => t(REASON_LABEL[reason])).join(' / ')} · {group.score}</span>
        <button class="propcraft-link" onClick={() => plugin.ignoreDuplicateGroup(group.id)}>{t('tags.ignoreGroup')}</button>
      </div>
      <div class="propcraft-group-members">
        {group.members.map(member => {
          const stat = snapshot.tags.get(member);
          return stat ? renderCard(stat) : null;
        })}
      </div>
    </div>
  );

  return (
    <div class="propcraft-page">
      <h2 class="propcraft-page-title">{t('tags.title')}</h2>
      <div class="propcraft-muted">{t('scope.current')}</div>

      <div class="propcraft-toolbar">
        <div class="propcraft-tabs" role="tablist">
          <button
            type="button"
            role="tab"
            aria-selected={viewMode === 'tree'}
            class={`propcraft-tab ${viewMode === 'tree' ? 'is-active' : ''}`}
            onClick={() => setViewMode('tree')}
          >
            {t('tags.view.tree')}
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={viewMode === 'list'}
            class={`propcraft-tab ${viewMode === 'list' ? 'is-active' : ''}`}
            onClick={() => setViewMode('list')}
          >
            {t('tags.view.list')}
          </button>
        </div>

        <input
          class="propcraft-input"
          placeholder={t('tags.search')}
          value={search}
          onInput={event => setSearch(event.currentTarget.value)}
        />

        {viewMode === 'list' ? (
          <label class="propcraft-check">
            <input type="checkbox" checked={duplicatesOnly} onChange={event => setDuplicatesOnly(event.currentTarget.checked)} />
            {t('tags.duplicatesOnly')}
          </label>
        ) : null}

        {viewMode === 'tree' && selectedNodes.length > 0 ? (
          <>
            <span class="propcraft-muted">{t('tags.tree.selectedCount', { count: selectedNodes.length })}</span>
            <button
              type="button"
              class="propcraft-btn mod-cta"
              disabled={!canPreview}
              onClick={() => setPropertyEditor({ nodes: selectedNodes })}
            >
              {t('tags.tree.convertSelected')}
            </button>
            <button type="button" class="propcraft-btn" onClick={() => setSelectedIds(new Set())}>
              {t('tags.tree.clearSelection')}
            </button>
          </>
        ) : null}
      </div>

      {!duplicatesOnly && tagGroups.length > 0 ? <div class="propcraft-groups">{tagGroups.map(renderGroup)}</div> : null}

      {viewMode === 'tree' ? (
        treeBusy || !tree ? (
          <div class="propcraft-empty" role="status">{t('tags.tree.loading')}</div>
        ) : (
          <TagTree
            tree={tree}
            search={search}
            selectedIds={selectedIds}
            canPreview={canPreview}
            t={t}
            plugin={plugin}
            onClearSearch={() => setSearch('')}
            onToggleSelect={toggleSelect}
            onDrillDown={(node, mode) => setDrillDown({
              title: t(mode === 'direct' ? 'tags.noteList.directTitle' : 'tags.noteList.branchTitle', { tag: node.displayTag }),
              paths: mode === 'direct' ? node.directPaths : node.branchPaths,
            })}
            onOpenBranchEditor={(node, includeDescendants, targetPrefill) => setBranchEditor({ node, includeDescendants, targetPrefill })}
            onOpenPropertyEditor={(nodes, branchLabel) => setPropertyEditor({ nodes, branchLabel })}
          />
        )
      ) : tags.length === 0 ? <div class="propcraft-empty">{t('tags.none')}</div> : (
        <div class="propcraft-table-wrap">
          <table class="propcraft-table">
            <thead>
              <tr>
                <th scope="col">{t('tags.col.tag')}</th>
                <th scope="col" class="num">{t('tags.col.files')}</th>
                <th scope="col">{t('tags.col.origin')}</th>
                <th scope="col">{t('properties.col.actions')}</th>
              </tr>
            </thead>
            <tbody>
              {tags.map(stat => (
                <tr
                  key={stat.tag}
                  draggable
                  onDragStart={() => setDragFrom(stat.tag)}
                  onDragEnd={() => setDragFrom(null)}
                  onDragOver={event => event.preventDefault()}
                  onDrop={event => { event.preventDefault(); if (dragFrom && dragFrom !== stat.tag) openExactEditor(dragFrom, stat.tag); setDragFrom(null); }}
                >
                  <td>{stat.tag}</td>
                  <td class="num">{stat.fileCount}</td>
                  <td>{originLabel(t, stat.origin)}</td>
                  <td class="propcraft-actions">
                    <button class="propcraft-link" disabled={!canPreview} onClick={() => openExactEditor(stat.tag, stat.tag)}>{t('common.rename')}</button>
                    <button class="propcraft-link" disabled={!canPreview} onClick={() => openExactEditor(stat.tag, '')}>{t('tags.mergeTo')}</button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {drillDown ? (
        <TagNoteList title={drillDown.title} paths={drillDown.paths} t={t} plugin={plugin} onClose={() => setDrillDown(null)} />
      ) : null}

      {branchEditor ? (
        <TagBranchEditor
          tree={tree ?? fallbackTree()}
          sourceNode={branchEditor.node}
          initialIncludeDescendants={branchEditor.includeDescendants}
          initialTarget={branchEditor.targetPrefill}
          t={t}
          onCancel={() => setBranchEditor(null)}
          onGenerate={operation => { setBranchEditor(null); void requestPreview(operation); }}
        />
      ) : null}

      {propertyEditor && tree ? (
        <TagPropertyEditor
          tree={tree}
          initialNodes={propertyEditor.nodes}
          branchLabel={propertyEditor.branchLabel}
          t={t}
          plugin={plugin}
          onCancel={() => setPropertyEditor(null)}
          onGenerate={operation => { setPropertyEditor(null); void requestPreview(operation); }}
        />
      ) : null}
    </div>
  );
}
