import type { PageProps } from '../types';

function StatCard({ label, value }: { label: string; value: number | string }) {
  return (
    <div class="propcraft-stat">
      <div class="propcraft-stat-value">{value}</div>
      <div class="propcraft-stat-label">{label}</div>
    </div>
  );
}

export function Overview({ snapshot, t, setTab, plugin, scope }: PageProps) {
  if (!snapshot) return <div class="propcraft-empty">{t('notice.indexing')}</div>;
  const { totals } = snapshot;
  const hasData = totals.noteCount > 0;
  return (
    <div class="propcraft-page">
      <h2 class="propcraft-page-title">{t('overview.title')}</h2>
      <div class="propcraft-muted">{t('scope.vaultStats')}</div>
      {scope ? <div>{t('scope.counts', { matched: scope.summary.matched, manual: scope.summary.manual, effective: scope.summary.effective, unknown: scope.summary.unknown })}</div> : null}
      <div class="propcraft-stats">
        <StatCard label={t('overview.noteCount')} value={totals.noteCount} />
        <StatCard label={t('overview.propertyKeys')} value={totals.propertyKeyCount} />
        <StatCard label={t('overview.tags')} value={totals.tagCount} />
        <StatCard label={t('overview.orphans')} value={totals.orphanCount} />
        <StatCard label={t('overview.duplicates')} value={totals.duplicateGroupCount} />
        <StatCard label={t('overview.parseErrors')} value={totals.parseErrorCount} />
      </div>

      {!hasData ? <div class="propcraft-empty">{t('overview.empty')}</div> : null}

      <h3 class="propcraft-section-title">{t('overview.suggestions')}</h3>
      {totals.orphanCount === 0 && totals.duplicateGroupCount === 0 ? (
        <div class="propcraft-muted">{t('overview.noSuggestions')}</div>
      ) : (
        <div class="propcraft-suggestions">
          {totals.orphanCount > 0 ? (
            <div class="propcraft-suggestion">
              <span>{t('overview.orphans')}: {totals.orphanCount}</span>
              <button class="propcraft-btn" onClick={() => setTab('properties')}>{t('overview.viewOrphans')}</button>
            </div>
          ) : null}
          {totals.duplicateGroupCount > 0 ? (
            <div class="propcraft-suggestion">
              <span>{t('overview.duplicates')}: {totals.duplicateGroupCount}</span>
              <button class="propcraft-btn" onClick={() => setTab('tags')}>{t('overview.mergeDuplicates')}</button>
            </div>
          ) : null}
        </div>
      )}

      <h3 class="propcraft-section-title">{t('overview.quickStart')}</h3>
      <div class="propcraft-quick">
        <button class="propcraft-btn" onClick={() => setTab('bulk')}>{t('overview.bulkAdd')}</button>
        <button class="propcraft-btn" onClick={() => setTab('properties')}>{t('overview.normalizeDates')}</button>
        <button class="propcraft-btn" onClick={() => plugin.reindex()}>{t('overview.reindex')}</button>
      </div>
    </div>
  );
}
