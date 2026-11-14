import { useState } from 'preact/hooks';
import type { OperationState } from '../../application/OperationCoordinator';
import type { PreviewView } from '../../domain/preview';
import type { Translate } from '../../i18n';
import type PropCraftPlugin from '../../main';
import { issueCode } from '../../domain/errors';
import { Dialog } from './Dialog';
import { issueText, stateText } from '../text';
import { RecoveryDrawer } from './RecoveryDrawer';
export function OperationPanel({ state, plugin, t, onPreview }: { state: OperationState; plugin: PropCraftPlugin; t: Translate; onPreview: (view: PreviewView) => void }) {
  const [filter, setFilter] = useState(''), [limit, setLimit] = useState(100), [pending, setPending] = useState(false);
  const run = async (action: () => Promise<unknown>) => {
    if (pending || plugin.coordinator.isBusy()) return;
    setPending(true);
    try { await action(); } catch (error) { plugin.notify(issueText(t, issueCode(error, 'journal-unavailable'))); } finally { setPending(false); }
  };
  if (state.kind === 'idle' || state.kind === 'recovery-required') return null;
  if (state.kind === 'preparing' || state.kind === 'running' || state.kind === 'stopping' || state.kind === 'recovering') return <Dialog title={state.kind === 'recovering' ? t('history.recovery.working') : state.kind === 'preparing' ? t('execute.preparing') : state.kind === 'stopping' ? t('execute.stopping') : t('execute.running', { done: state.progress.done, total: state.progress.total })} closeLabel={t('common.close')}>
    {state.kind === 'running' || state.kind === 'stopping' ? <div class="propcraft-progress-track" role="progressbar" aria-valuemin={0} aria-valuemax={state.progress.total} aria-valuenow={state.progress.done}><div class="propcraft-progress-bar" style={{ width: `${state.progress.total ? state.progress.done / state.progress.total * 100 : 0}%` }} /></div> : null}
    <div role="status" aria-live="polite">{state.kind === 'stopping' ? t('execute.stopping') : null}</div>
    <div class="propcraft-dialog-actions"><button class="propcraft-btn" disabled={state.kind === 'stopping'} onClick={() => plugin.coordinator.cancel()}>{t('common.cancel')}</button></div>
  </Dialog>;
  if (state.kind === 'recovery-preview') return <RecoveryDrawer preview={state.preview} t={t} plugin={plugin} onClose={() => plugin.coordinator.dismiss()} onRecover={() => void run(() => plugin.coordinator.recover(state.preview.id, state.preview.revision))} onRecheck={() => void run(() => plugin.coordinator.reconcile(state.preview.transactionId))} />;
  const execution = state.kind === 'result' ? state.result : null;
  const recovery = state.kind === 'recovery-result' ? state.result : null;
  const rows = execution ? execution.items.map(item => ({ path: item.path, reason: item.reason, status: item.status })) : recovery!.items.map(item => ({ path: item.path, reason: item.reason, status: item.kind }));
  const visible = rows.filter(item => item.path.toLowerCase().includes(filter.toLowerCase()));
  const count = (status: string) => rows.filter(item => item.status === status).length;
  const transactionId = execution?.transactionId ?? recovery!.transactionId;
  const retry = async (mode: 'unfinished' | 'failed' | 'not-run' | 'stale') => {
    const preview = await plugin.coordinator.retry(transactionId, mode);
    plugin.coordinator.dismiss(); onPreview(preview);
  };
  return <Dialog drawer title={t('execute.result')} closeLabel={t('common.close')} onClose={() => plugin.coordinator.dismiss()}>
    <div class="propcraft-drawer-summary" role="status">
      {execution ? <><div>{t('execute.resultCounts', { applied: count('applied'), failed: count('failed'), skipped: count('skipped') + count('stale'), notRun: count('not-run'), uncertain: count('uncertain') })}</div><div>{t('execute.type', { status: stateText(t, execution.typeStatus) })}</div>{execution.cancelled ? <div>{t('execute.cancelled')}</div> : null}</> : <div>{t(recovery!.complete ? 'history.recovery.complete' : 'history.recovery.partial')}</div>}
      {recovery?.typeReason ? <div class="propcraft-warn">{issueText(t, recovery.typeReason)}</div> : null}
      {(execution ?? recovery)?.requiresReconciliation ? <div class="propcraft-warn">{t('execute.required')}</div> : null}
    </div>
    <input class="propcraft-input" aria-label={t('preview.filter')} placeholder={t('preview.filter')} value={filter} onInput={event => { setFilter(event.currentTarget.value); setLimit(100); }} />
    <div class="propcraft-drawer-body">{visible.slice(0, limit).map(item => <div class="propcraft-diff" key={item.path}><strong class="propcraft-path">{item.path}</strong><div>{execution ? stateText(t, item.status) + ' · ' : ''}{issueText(t, item.reason)}</div><button class="propcraft-link" onClick={() => void plugin.openNote(item.path)}>{t('scope.open')}</button></div>)}{visible.length > limit ? <button class="propcraft-btn" onClick={() => setLimit(limit + 100)}>{t('preview.more')}</button> : null}</div>
    <div class="propcraft-drawer-actions">
      <button class="propcraft-btn" disabled={pending} onClick={() => void run(() => plugin.coordinator.reconcile(transactionId))}>{t('execute.review')}</button>
      <button class="propcraft-btn" disabled={pending} onClick={() => void run(() => plugin.coordinator.previewRecovery(transactionId))}>{t('execute.undo')}</button>
      {execution && !execution.requiresReconciliation ? <>
        {count('failed') + count('not-run') ? <button class="propcraft-btn" disabled={pending} onClick={() => void run(() => retry('unfinished'))}>{t('execute.retry')}</button> : null}
        {count('failed') ? <button class="propcraft-btn" disabled={pending} onClick={() => void run(() => retry('failed'))}>{t('execute.retryFailed')}</button> : null}
        {count('not-run') ? <button class="propcraft-btn" disabled={pending} onClick={() => void run(() => retry('not-run'))}>{t('execute.retryNotRun')}</button> : null}
        {count('stale') ? <button class="propcraft-btn" disabled={pending} onClick={() => void run(() => retry('stale'))}>{t('execute.retryStale')}</button> : null}
      </> : null}
      <button class="propcraft-btn" onClick={() => plugin.coordinator.dismiss()}>{t('common.close')}</button>
    </div>
  </Dialog>;
}
