import { useMemo, useState } from 'preact/hooks';
import type { Translate } from '../../i18n';
import type PropCraftPlugin from '../../main';
import { Dialog } from './Dialog';

const PAGE = 50;

export function ValueNoteList({ title, paths, plugin, t, onClose }: {
  title: string; paths: readonly string[]; plugin: PropCraftPlugin; t: Translate; onClose: () => void;
}) {
  const [search, setSearch] = useState('');
  const [limit, setLimit] = useState(PAGE);
  const filtered = useMemo(() => {
    const needle = search.trim().toLowerCase();
    return [...new Set(paths)].filter(path => !needle || path.toLowerCase().includes(needle)).sort((a, b) => a.localeCompare(b));
  }, [paths, search]);
  return <Dialog drawer title={title} closeLabel={t('common.close')} onClose={onClose}>
    <div class="propcraft-drawer-summary" role="status"><div>{t('values.note.count', { count: filtered.length })}</div></div>
    <div class="propcraft-toolbar"><input class="propcraft-input" placeholder={t('values.note.search')} value={search} onInput={event => { setSearch(event.currentTarget.value); setLimit(PAGE); }} /></div>
    <div class="propcraft-drawer-body">
      {filtered.length === 0 ? <div class="propcraft-empty">{t('values.note.none')}</div> : filtered.slice(0, limit).map(path => (
        <div class="propcraft-diff" key={path}>
          <strong class="propcraft-path">{path}</strong>
          {paths.filter(item => item === path).length > 1 ? <span class="propcraft-muted">{t('values.note.repeat', { count: paths.filter(item => item === path).length })}</span> : null}
          <button class="propcraft-link" onClick={() => void plugin.openNote(path)}>{t('values.note.open')}</button>
        </div>
      ))}
      {filtered.length > limit ? <button class="propcraft-btn" onClick={() => setLimit(limit + PAGE)}>{t('preview.more')}</button> : null}
    </div>
  </Dialog>;
}
