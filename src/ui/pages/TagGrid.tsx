import { useState } from 'preact/hooks';
import type { DuplicateGroup, DuplicateReason, TagStat } from '../../domain/models';
import type { TextKey } from '../../i18n';
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

export function TagGrid({ snapshot, t, plugin, onPreview }: PageProps) {
  const [search, setSearch] = useState('');
  const [duplicatesOnly, setDuplicatesOnly] = useState(false);
  const [dragFrom, setDragFrom] = useState<string | null>(null);

  if (!snapshot) return <div class="propcraft-empty">{t('notice.indexing')}</div>;

  const merge = (from: string, to: string) => {
    if (from === to) return;
    onPreview(plugin.planner.planMergeTag(from, to));
  };

  const promptMerge = async (from: string) => {
    const target = await plugin.prompt(t('tags.mergeTo'), '');
    if (target && target !== from) merge(from, target);
  };

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
        if (dragFrom) merge(dragFrom, stat.tag);
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
      <div class="propcraft-toolbar">
        <input class="propcraft-input" placeholder={t('tags.search')} value={search} onInput={event => setSearch((event.target as HTMLInputElement).value)} />
        <label class="propcraft-check">
          <input type="checkbox" checked={duplicatesOnly} onChange={event => setDuplicatesOnly((event.target as HTMLInputElement).checked)} />
          {t('tags.duplicatesOnly')}
        </label>
        <span class="propcraft-muted">{t('tags.mergeHint')}</span>
      </div>

      {!duplicatesOnly && tagGroups.length > 0 ? <div class="propcraft-groups">{tagGroups.map(renderGroup)}</div> : null}

      {tags.length === 0 ? <div class="propcraft-empty">{t('tags.none')}</div> : (
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
                  onDrop={event => { event.preventDefault(); if (dragFrom) merge(dragFrom, stat.tag); setDragFrom(null); }}
                >
                  <td>{stat.tag}</td>
                  <td class="num">{stat.fileCount}</td>
                  <td>{originLabel(t, stat.origin)}</td>
                  <td class="propcraft-actions">
                    <button class="propcraft-link" onClick={() => void promptMerge(stat.tag)}>{t('tags.mergeTo')}</button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
