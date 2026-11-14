import { useState } from 'preact/hooks';
import type { ScopeQuery, ScopeResult } from '../../domain/scope';
import type { VaultSnapshot } from '../../domain/models';
import type { Translate } from '../../i18n';
import type PropCraftPlugin from '../../main';
import { Dialog } from './Dialog';
import { issueText } from '../text';
export function ScopeFileList({ query, result, snapshot, onChange, onClose, plugin, t }: {
  query: ScopeQuery; result: ScopeResult; snapshot: VaultSnapshot | null; onChange: (query: ScopeQuery) => void; onClose: () => void; plugin: PropCraftPlugin; t: Translate;
}) {
  const [search, setSearch] = useState(''), [limit, setLimit] = useState(100);
  const manual = new Set(query.manuallyExcludedPaths);
  const rows = [
    ...result.matchedPaths.map(path => ({ path, group: 'match' as const })),
    ...result.unknownPaths.map(path => ({ path, group: 'unknown' as const })),
    ...result.globallyExcludedPaths.map(path => ({ path, group: 'global' as const })),
  ].filter(row => row.path.toLowerCase().includes(search.toLowerCase())).sort((a, b) => a.path.localeCompare(b.path));
  return <Dialog drawer title={t('scope.files')} closeLabel={t('common.close')} onClose={onClose}>
    <input class="propcraft-input" aria-label={t('preview.filter')} placeholder={t('preview.filter')} value={search} onInput={event => { setSearch(event.currentTarget.value); setLimit(100); }} />
    <div class="propcraft-drawer-body">{rows.slice(0, limit).map(row => <div class="propcraft-diff" key={row.path}>
      <label class="propcraft-check"><input type="checkbox" aria-label={`${t('scope.manual')}: ${row.path}`} checked={row.group === 'match' && !manual.has(row.path)} disabled={row.group !== 'match'} onChange={event => {
        const paths = new Set(query.manuallyExcludedPaths);
        if (event.currentTarget.checked) paths.delete(row.path); else paths.add(row.path);
        onChange({ ...query, manuallyExcludedPaths: [...paths] });
      }} /><strong>{row.path.split('/').at(-1)}</strong></label>
      <div class="propcraft-path">{row.path}</div>
      <div class="propcraft-muted">{row.group === 'match' ? t('scope.matched') : row.group === 'global' ? t('scope.excluded') : issueText(t, result.reasons[row.path])}</div>
      {Object.values(snapshot?.files.get(row.path)?.rawFrontmatter ?? {}).some(value => typeof value === 'string' && value.length > 0 && !value.trim()) ? <div class="propcraft-muted">{t('scope.whitespace')}</div> : null}
      <button class="propcraft-link" onClick={() => void plugin.openNote(row.path)}>{t('scope.open')}</button>
    </div>)}{rows.length > limit ? <button class="propcraft-btn" onClick={() => setLimit(limit + 100)}>{t('preview.more')}</button> : null}</div>
  </Dialog>;
}
