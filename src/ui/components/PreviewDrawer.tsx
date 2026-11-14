import { useState } from 'preact/hooks';
import type { PreviewDecisionPatch, PreviewView } from '../../domain/preview';
import type { MergeStrategy } from '../../domain/models';
import type { Translate } from '../../i18n';
import type PropCraftPlugin from '../../main';
import { issueText } from '../text';
import { Dialog } from './Dialog';
import { ConflictEditor } from './ConflictEditor';
interface Props {
  plan: PreviewView; t: Translate; plugin: PropCraftPlugin; busy: boolean; dataUpdated: boolean;
  onApply: () => void; onCancel: () => void; onRevise: (patches: readonly PreviewDecisionPatch[]) => void; onRebuild: (staleOnly?: boolean) => void;
}
export function PreviewDrawer({ plan, t, plugin, busy, dataUpdated, onApply, onCancel, onRevise, onRebuild }: Props) {
  const [filter, setFilter] = useState(''), [group, setGroup] = useState('all'), [limit, setLimit] = useState(100);
  const [strategy, setStrategy] = useState<MergeStrategy>('keep-target'), [override, setOverride] = useState(false);
  const filtered = plan.items.filter(item => item.path.toLowerCase().includes(filter.toLowerCase()) && (group === 'all' || group === 'conflict' ? group !== 'conflict' || item.conflict : group === 'blocked' ? item.disposition === 'blocked' : item.disposition === 'skip' || item.disposition === 'noop'));
  const selectable = filtered.filter(item => item.state === 'ready' && !item.stale);
  const batchConflicts = filtered.filter(item => item.conflict && item.allowedStrategies.includes(strategy) && (!item.decision.individual || override) && !item.stale);
  const summary = plan.typeSummary;
  return <Dialog drawer title={t('preview.title')} closeLabel={t('common.close')} onClose={busy ? undefined : onCancel}>
    <div class="propcraft-drawer-summary" role="status" aria-live="polite">
      <div>{t('scope.filtered', { base: plan.scopeSummary.base.kind === 'all' ? t('scope.all') : plan.scopeSummary.base.path + '/', count: plan.scopeSummary.effective })}</div>
      <div>{t('preview.counts', { ...plan.summary })}</div>
      {plan.summary.conflicts ? <div class="propcraft-warn">{t('preview.conflict', { count: plan.summary.conflicts })}</div> : null}
      <div class="propcraft-muted">{t(`preview.type.${summary.kind}`, { key: summary.targetKey ?? '', type: summary.type ?? '' })}</div>
      <div class="propcraft-muted">{t('preview.yaml')}</div>
      {plan.operation.kind === 'renameTag' || plan.operation.kind === 'mergeTag' ? <div>{t('preview.exactTag')}</div> : null}
      {plan.operation.kind === 'normalizeDate' ? <div>{t('preview.dateRegion', { target: plan.operation.target, region: plan.operation.regionFormat === 'MDY' ? 'MM/DD/YYYY' : plan.operation.regionFormat === 'DMY' ? 'DD/MM/YYYY' : 'YYYY/MM/DD' })}</div> : null}
      {plan.retryOf ? <div>{t('preview.retry', { id: plan.retryOf })}</div> : null}
      {dataUpdated ? <div>{t('preview.newData')}</div> : null}
      {plan.invalid ? <div class="propcraft-warn" role="alert">{issueText(t, plan.invalid)}</div> : null}
      {busy ? <div>{t('preview.updating')}</div> : null}
    </div>
    <div class="propcraft-toolbar"><input class="propcraft-input" aria-label={t('preview.filter')} placeholder={t('preview.filter')} value={filter} onInput={event => { setFilter(event.currentTarget.value); setLimit(100); }} />
      <select class="propcraft-input" aria-label={t('preview.all')} value={group} onChange={event => { setGroup(event.currentTarget.value); setLimit(100); }}><option value="all">{t('preview.all')}</option><option value="conflict">{t('preview.conflicts')}</option><option value="skip">{t('preview.skipped')}</option><option value="blocked">{t('preview.blocked')}</option></select></div>
    <div class="propcraft-toolbar">
      <button class="propcraft-btn" disabled={busy || !selectable.length} onClick={() => onRevise(selectable.map(item => ({ path: item.path, beforeHash: item.decision.beforeHash, selected: true })))}>{t('preview.selectVisible', { count: selectable.length })}</button>
      <button class="propcraft-btn" disabled={busy || !selectable.length} onClick={() => onRevise(selectable.map(item => ({ path: item.path, beforeHash: item.decision.beforeHash, selected: false })))}>{t('preview.deselectVisible')}</button>
    </div>
    {plan.items.some(item => item.conflict) ? <div class="propcraft-toolbar">
      <select class="propcraft-input" aria-label={t('preview.decision.batch')} value={strategy} onChange={event => setStrategy(event.currentTarget.value as MergeStrategy)}>{(['keep-target', 'keep-source', 'merge-list', 'skip'] as const).map(value => <option value={value} key={value}>{t(`preview.decision.${value}`)}</option>)}</select>
      <label class="propcraft-check"><input type="checkbox" checked={override} onChange={event => setOverride(event.currentTarget.checked)} />{t('preview.decision.override')}</label>
      <button class="propcraft-btn" disabled={busy || !batchConflicts.length} onClick={() => onRevise(batchConflicts.map(item => ({ path: item.path, beforeHash: item.decision.beforeHash, merge: strategy, selected: strategy !== 'skip', individual: false })))}>{t('preview.decision.batch')} ({batchConflicts.length})</button>
    </div> : null}
    <div class="propcraft-drawer-body">{filtered.slice(0, limit).map(item => <div class="propcraft-diff" key={item.path}>
      <label class="propcraft-check"><input type="checkbox" aria-label={`${t('preview.select')}: ${item.path}`} checked={item.disposition === 'execute'} disabled={busy || item.state !== 'ready' || item.stale} onChange={event => onRevise([{ path: item.path, beforeHash: item.decision.beforeHash, selected: event.currentTarget.checked }])} /><strong class="propcraft-path">{item.path}</strong></label>
      {item.reason ? <div class={item.stale || item.disposition === 'blocked' ? 'propcraft-warn' : 'propcraft-muted'}>{issueText(t, item.reason)}</div> : null}
      {item.conflictValues ? <div class="propcraft-diff-row"><span>{item.conflictValues.source}</span><span>{item.conflictValues.target}</span></div> : null}
      <ConflictEditor item={item} t={t} disabled={busy} onChange={patch => onRevise([patch])} />
      {item.diffs.map((hunk, index) => <div class={`propcraft-diff-row ${hunk.kind === 'del' ? 'is-del' : hunk.kind === 'add' ? 'is-add' : ''}`} key={index}>
        <span class="propcraft-diff-label">{hunk.label === 'body' ? t('diff.body') : hunk.label}</span>
        {hunk.before !== undefined ? <span class="propcraft-diff-before">− {hunk.before}</span> : null}{hunk.after !== undefined ? <span class="propcraft-diff-after">+ {hunk.after}</span> : null}
      </div>)}
      <button class="propcraft-link" onClick={() => void plugin.openNote(item.path)}>{t('scope.open')}</button>
    </div>)}{filtered.length > limit ? <button class="propcraft-btn" onClick={() => setLimit(limit + 100)}>{t('preview.more')}</button> : null}</div>
    <div class="propcraft-drawer-actions">
      <button class="propcraft-btn" disabled={busy} onClick={onCancel}>{t('preview.cancel')}</button>
      {plan.invalid || dataUpdated ? <button class="propcraft-btn" disabled={busy} onClick={() => onRebuild()}>{t('preview.rebuild')}</button> : null}
      {plan.items.some(item => item.stale) ? <button class="propcraft-btn" disabled={busy} onClick={() => onRebuild(true)}>{t('preview.stale')}</button> : null}
      <button class="propcraft-btn mod-cta" disabled={busy || Boolean(plan.invalid) || !plan.summary.execute || plugin.coordinator.isBusy()} onClick={onApply}>{t('preview.applyCount', { count: plan.summary.execute })}</button>
    </div>
  </Dialog>;
}
