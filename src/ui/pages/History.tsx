import { useEffect, useState } from 'preact/hooks';
import type { ChangeOperation } from '../../domain/models';
import type { JournalListItem } from '../../domain/journal';
import { issueCode } from '../../domain/errors';
import { issueText, stateText } from '../text';
import type { PageProps } from '../types';
function describe(operation: ChangeOperation, t: PageProps['t']): string {
  switch (operation.kind) {
    case 'renameTag': return `${t('common.rename')} ${operation.from} → ${operation.to}`;
    case 'mergeTag': case 'mergeProperty': return `${t('common.merge')} ${operation.from} → ${operation.to}`;
    case 'renameProperty': return `${t('common.rename')} ${operation.from} → ${operation.to}`;
    case 'deleteProperty': return `${t('properties.delete')} ${operation.key}`;
    case 'addProperty': return `${t('wizard.title')}: ${operation.key} = ${JSON.stringify(operation.value)}`;
    case 'normalizeDate': return `${t('properties.normalizeDates')}: ${operation.key}`;
  }
}
export function History({ plugin, t }: PageProps) {
  const [metas, setMetas] = useState<JournalListItem[]>([]), [error, setError] = useState<string>(), [busy, setBusy] = useState(false);
  const load = () => {
    void plugin.journal.list().then(items => { setMetas(items); setError(undefined); }).catch(() => setError(t('issue.journal-unavailable')));
  };
  useEffect(() => { load(); return plugin.coordinator.subscribe(state => { if (state.kind === 'result' || state.kind === 'recovery-result' || state.kind === 'idle') load(); }); }, [plugin]);
  const run = async (action: () => Promise<unknown>) => {
    if (busy || plugin.coordinator.isBusy()) return;
    setBusy(true);
    try { await action(); } catch (error) { setError(issueText(t, issueCode(error, 'journal-unavailable'))); } finally { setBusy(false); load(); }
  };
  return <div class="propcraft-page"><h2 class="propcraft-page-title">{t('history.title')}</h2>
    <div class="propcraft-muted">{t('journal.capacity.usage', { count: metas.length, bytes: metas.reduce((sum, meta) => sum + meta.bytes, 0), reserved: metas.reduce((sum, meta) => sum + meta.reservedBytes, 0), maxCount: plugin.settings.journalMaxTransactions, maxBytes: plugin.settings.journalMaxBytes })}</div>
    <div class="propcraft-toolbar"><button class="propcraft-btn" onClick={() => void run(() => plugin.coordinator.refreshStatus())}>{t('history.refresh')}</button><button class="propcraft-link" onClick={() => plugin.openSettings()}>{t('journal.capacity.settings')}</button></div>
    {error ? <div class="propcraft-warn" role="alert">{error}</div> : null}
    {metas.length === 0 ? <div class="propcraft-empty">{t('history.empty')}</div> : <div class="propcraft-table-wrap"><table class="propcraft-table"><thead><tr>
      <th scope="col">{t('history.col.action')}</th><th scope="col">{t('history.when')}</th><th scope="col">{t('history.col.status')}</th><th scope="col">{t('properties.col.actions')}</th>
    </tr></thead><tbody>{metas.map(meta => <tr key={meta.transactionId}>
      <td><div>{meta.operation ? describe(meta.operation, t) : meta.transactionId}</div><div class="propcraft-muted propcraft-path">{meta.transactionId}</div>{meta.retryOf ? <div>{t('history.retryOf', { id: meta.retryOf })}</div> : null}{meta.kind === 'legacy' ? <div class="propcraft-muted">{t('history.legacy')}</div> : null}</td>
      <td>{meta.createdAt ? <time>{new Date(meta.createdAt).toLocaleString()}</time> : null}{meta.scopeSummary ? <div>{t('scope.filtered', { base: meta.scopeSummary.base.kind === 'all' ? t('scope.all') : meta.scopeSummary.base.path + '/', count: meta.scopeSummary.effective })}</div> : null}<div>{t('history.fileCount', { count: meta.fileCount })}</div></td>
      <td>{meta.issue ? <div class="propcraft-warn">{t('history.readonly', { reason: issueText(t, meta.issue) })}</div> : null}
        {meta.execution ? <div>{stateText(t, meta.execution)} · {stateText(t, meta.recovery ?? 'none')}</div> : null}
        {Object.entries(meta.counts ?? {}).map(([status, count]) => <div class="propcraft-muted" key={status}>{stateText(t, status)}: {count}</div>)}
      </td><td class="propcraft-actions">
        {meta.kind === 'v2' && !meta.issue ? <button class="propcraft-link" disabled={busy} onClick={() => void run(() => plugin.coordinator.viewResult(meta.transactionId))}>{t('history.results')}</button> : null}
        {meta.kind === 'v2' || meta.kind === 'legacy' ? <button class="propcraft-link" disabled={busy} onClick={() => void run(() => plugin.coordinator.previewRecovery(meta.transactionId))}>{t('history.recovery.title')}</button> : null}
        {meta.needsReconciliation && (meta.kind === 'v2' || meta.kind === 'legacy') ? <button class="propcraft-link" disabled={busy} onClick={() => void run(() => plugin.coordinator.reconcile(meta.transactionId))}>{t('execute.review')}</button> : null}
        {meta.canRemove ? <button class="propcraft-link mod-danger" disabled={busy} onClick={() => void run(async () => { if (await plugin.confirm(t('history.removeConfirm'))) await plugin.coordinator.removeOne(meta.transactionId); })}>{t('history.remove')}</button> : null}
      </td></tr>)}</tbody></table></div>}
  </div>;
}
