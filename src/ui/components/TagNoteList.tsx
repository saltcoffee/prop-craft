import { useState } from 'preact/hooks';
import type { Translate } from '../../i18n';
import type PropCraftPlugin from '../../main';
import { Dialog } from './Dialog';

interface Props {
  title: string;
  paths: readonly string[];
  t: Translate;
  plugin: PropCraftPlugin;
  onClose: () => void;
}

export function TagNoteList({ title, paths, t, plugin, onClose }: Props) {
  const [search, setSearch] = useState('');
  const [limit, setLimit] = useState(100);
  const query = search.trim().toLowerCase();
  const visible = query ? paths.filter(path => path.toLowerCase().includes(query)) : paths;

  return (
    <Dialog drawer title={title} closeLabel={t('common.close')} onClose={onClose}>
      <div class="propcraft-drawer-summary" role="status">
        <div>{t('tags.noteList.count', { count: visible.length })}</div>
      </div>
      <div class="propcraft-toolbar">
        <input
          class="propcraft-input"
          placeholder={t('tags.noteList.search')}
          value={search}
          onInput={event => { setSearch(event.currentTarget.value); setLimit(100); }}
        />
      </div>
      <div class="propcraft-drawer-body">
        {visible.length === 0 ? <div class="propcraft-empty">{t('tags.noteList.empty')}</div> : (
          visible.slice(0, limit).map(path => (
            <div class="propcraft-diff" key={path}>
              <div class="propcraft-diff-row">
                <strong class="propcraft-path">{path}</strong>
                <button class="propcraft-link" onClick={() => void plugin.openNote(path)}>{t('scope.open')}</button>
              </div>
            </div>
          ))
        )}
        {visible.length > limit ? (
          <button class="propcraft-btn" onClick={() => setLimit(limit + 100)}>{t('preview.more')}</button>
        ) : null}
      </div>
      <div class="propcraft-drawer-actions">
        <button class="propcraft-btn" onClick={onClose}>{t('common.close')}</button>
      </div>
    </Dialog>
  );
}
