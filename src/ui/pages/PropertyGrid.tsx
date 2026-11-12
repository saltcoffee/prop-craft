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
  return stat.sampleValues.map(value => (typeof value === 'string' ? value : JSON.stringify(value))).join(', ');
}

export function PropertyGrid({ snapshot, t, plugin, onPreview }: PageProps) {
  const [search, setSearch] = useState('');
  const [onlyOrphans, setOnlyOrphans] = useState(false);

  if (!snapshot) return <div class="propcraft-empty">{t('notice.indexing')}</div>;

  const rows = [...snapshot.properties.values()]
    .filter(stat => (onlyOrphans ? stat.isOrphan : true))
    .filter(stat => stat.key.toLowerCase().includes(search.toLowerCase()))
    .sort((a, b) => b.fileCount - a.fileCount || a.key.localeCompare(b.key));

  const rename = async (stat: PropertyStat) => {
    const next = await plugin.prompt(t('properties.rename'), stat.key);
    if (!next || next === stat.key) return;
    onPreview(plugin.planner.planRenameProperty(stat.key, next));
  };
  const mergeInto = async (stat: PropertyStat) => {
    const target = await plugin.prompt(t('properties.mergeInto'), '');
    if (!target || target === stat.key) return;
    onPreview(plugin.planner.planMergeProperty(stat.key, target, 'merge-list'));
  };
  const remove = async (stat: PropertyStat) => {
    const ok = await plugin.confirm(t('properties.deleteConfirm', { key: stat.key, count: stat.fileCount }));
    if (!ok) return;
    onPreview(plugin.planner.planDeleteProperty(stat.key));
  };
  const normalize = (stat: PropertyStat) => {
    onPreview(plugin.planner.planNormalizeDate(stat.key, 'date', plugin.settings.dateRegionFormat));
  };

  return (
    <div class="propcraft-page">
      <h2 class="propcraft-page-title">{t('properties.title')}</h2>
      <div class="propcraft-toolbar">
        <input class="propcraft-input" placeholder={t('properties.search')} value={search} onInput={event => setSearch((event.target as HTMLInputElement).value)} />
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
                        <button class="propcraft-link" onClick={() => void rename(stat)}>{t('properties.rename')}</button>
                        <button class="propcraft-link" onClick={() => void mergeInto(stat)}>{t('properties.mergeInto')}</button>
                        <button class="propcraft-link" onClick={() => normalize(stat)}>{t('properties.normalizeDates')}</button>
                        <button class="propcraft-link mod-danger" onClick={() => void remove(stat)}>{t('properties.delete')}</button>
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
