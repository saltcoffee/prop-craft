import { useState } from 'preact/hooks';
import type { PropertyStat, PropertyValueType } from '../../domain/models';
import type { PageProps } from '../types';

function dominantType(stat: PropertyStat): PropertyValueType {
  let best: PropertyValueType = 'text';
  let bestCount = -1;
  for (const [type, count] of Object.entries(stat.typeDistribution) as Array<[PropertyValueType, number]>) {
    if (count > bestCount) { best = type; bestCount = count; }
  }
  return bestCount > 0 ? best : 'unknown';
}

function sampleText(stat: PropertyStat): string {
  if (!stat.sampleValues.length) return '—';
  return stat.sampleValues.map(value => (typeof value === 'string' ? value.length > 0 && !value.trim() ? JSON.stringify(value) : value : JSON.stringify(value))).join(', ');
}

export function PropertyGrid({ snapshot, t, plugin, requestPreview, canPreview }: PageProps) {
  const [search, setSearch] = useState('');
  const [onlyOrphans, setOnlyOrphans] = useState(false);
  const [dateTarget, setDateTarget] = useState<'date' | 'datetime'>('date');

  if (!snapshot) return <div class="propcraft-empty">{t('notice.indexing')}</div>;

  const rows = [...snapshot.properties.values()]
    .filter(stat => (onlyOrphans ? stat.isOrphan : true))
    .filter(stat => stat.key.toLowerCase().includes(search.toLowerCase()))
    .sort((a, b) => b.fileCount - a.fileCount || a.key.localeCompare(b.key));

  const rename = async (stat: PropertyStat) => {
    const next = await plugin.prompt(t('properties.rename'), stat.key);
    if (!next || next === stat.key) return;
    await requestPreview({ kind: 'renameProperty', from: stat.key, to: next });
  };
  const mergeInto = async (stat: PropertyStat) => {
    const target = await plugin.prompt(t('properties.mergeInto'), '');
    if (!target || target === stat.key) return;
    await requestPreview({ kind: 'mergeProperty', from: stat.key, to: target });
  };
  const remove = async (stat: PropertyStat) => {
    await requestPreview({ kind: 'deleteProperty', key: stat.key });
  };
  const normalize = (stat: PropertyStat) => {
    void requestPreview({ kind: 'normalizeDate', key: stat.key, target: dateTarget, regionFormat: plugin.settings.dateRegionFormat });
  };

  return (
    <div class="propcraft-page">
      <h2 class="propcraft-page-title">{t('properties.title')}</h2>
      <div class="propcraft-muted">{t('scope.current')}</div>
      <div class="propcraft-toolbar">
        <input class="propcraft-input" placeholder={t('properties.search')} value={search} onInput={event => setSearch((event.target as HTMLInputElement).value)} />
        <label>{t('preview.dateTarget')} <select class="propcraft-input" value={dateTarget} onChange={event => setDateTarget(event.currentTarget.value === 'datetime' ? 'datetime' : 'date')}><option value="date">YYYY-MM-DD</option><option value="datetime">YYYY-MM-DDTHH:mm</option></select></label>
        <label class="propcraft-check">
          <input type="checkbox" checked={onlyOrphans} onChange={event => setOnlyOrphans((event.target as HTMLInputElement).checked)} />
          {t('properties.onlyOrphans')}
        </label>
      </div>
      {rows.length === 0 ? <div class="propcraft-empty">{t('properties.none')}</div> : (
        <div class="propcraft-table-wrap">
          <table class="propcraft-table">
            <thead>
              <tr>
                <th scope="col">{t('properties.col.key')}</th>
                <th scope="col" class="num">{t('properties.col.files')}</th>
                <th scope="col">{t('properties.col.type')}</th>
                <th scope="col">{t('properties.col.sample')}</th>
                <th scope="col">{t('properties.col.actions')}</th>
              </tr>
            </thead>
            <tbody>
              {rows.map(stat => (
                <tr key={stat.key} class={stat.isOrphan ? 'is-orphan' : ''}>
                  <td>
                    {stat.key}
                    {stat.isReserved ? <span class="propcraft-badge">{t('properties.reserved')}</span> : null}
                    {stat.isOrphan ? <span class="propcraft-badge mod-warn">{t('properties.orphan')}</span> : null}
                  </td>
                  <td class="num">{stat.fileCount}</td>
                  <td>{dominantType(stat)}</td>
                  <td class="propcraft-muted">{sampleText(stat)}</td>
                  <td class="propcraft-actions">
                    {!stat.isReserved ? (
                      <>
                        <button class="propcraft-link" disabled={!canPreview} onClick={() => void rename(stat)}>{t('properties.rename')}</button>
                        <button class="propcraft-link" disabled={!canPreview} onClick={() => void mergeInto(stat)}>{t('properties.mergeInto')}</button>
                        <button class="propcraft-link" disabled={!canPreview} onClick={() => normalize(stat)}>{t('properties.normalizeDates')}</button>
                        <button class="propcraft-link mod-danger" disabled={!canPreview} onClick={() => void remove(stat)}>{t('properties.delete')}</button>
                      </>
                    ) : <span class="propcraft-muted">—</span>}
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
