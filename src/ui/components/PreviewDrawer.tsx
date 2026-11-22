import { useState } from 'preact/hooks';
import type { PreviewDecisionPatch, PreviewView, TagPropertyResolution } from '../../domain/preview';
import type { MergeStrategy } from '../../domain/models';
import { sameTagResolution } from '../../domain/tag-property';
import type { Translate } from '../../i18n';
import type PropCraftPlugin from '../../main';
import { issueText } from '../text';
import { displayScalar, displayValue } from '../value-format';
import { Dialog } from './Dialog';
import { ConflictEditor } from './ConflictEditor';

interface Props {
  plan: PreviewView; t: Translate; plugin: PropCraftPlugin; busy: boolean; dataUpdated: boolean;
  onApply: () => void; onCancel: () => void; onRevise: (patches: readonly PreviewDecisionPatch[]) => void; onRebuild: (staleOnly?: boolean) => void;
}

export function PreviewDrawer({ plan, t, plugin, busy, dataUpdated, onApply, onCancel, onRevise, onRebuild }: Props) {
  const [filter, setFilter] = useState(''), [group, setGroup] = useState('all'), [limit, setLimit] = useState(100);
  const [strategy, setStrategy] = useState<MergeStrategy>('keep-target'), [override, setOverride] = useState(false);
  const [batchTagAction, setBatchTagAction] = useState('');

  const filtered = plan.items.filter(item =>
    item.path.toLowerCase().includes(filter.toLowerCase())
    && (group === 'all' || group === 'conflict'
      ? group !== 'conflict' || item.conflict
      : group === 'blocked' ? item.disposition === 'blocked' : item.disposition === 'skip' || item.disposition === 'noop'),
  );
  const selectable = filtered.filter(item => item.state === 'ready' && !item.stale);
  const batchConflicts = filtered.filter(item => item.conflict && item.allowedStrategies.includes(strategy) && (!item.decision.individual || override) && !item.stale);
  const summary = plan.typeSummary;
  const branchSummary = plan.tagBranchSummary;
  const isTagMigration = plan.operation.kind === 'migrateTagBranch' || plan.operation.kind === 'convertTagsToProperty';

  // Compute batch resolution options and eligible/ineligible counts for convertTagsToProperty.
  const tagBatchOptions: { key: string; label: string; resolution: TagPropertyResolution }[] = [];
  if (plan.operation.kind === 'convertTagsToProperty') {
    if (plan.operation.mode === 'scalar') {
      for (const rule of plan.operation.rules) {
        tagBatchOptions.push({
          key: `use:${rule.id}`,
          label: t('tags.toProperty.useMapped', { value: displayScalar(rule.value), tag: rule.tag }),
          resolution: { kind: 'use-mapped', ruleId: rule.id },
        });
      }
    } else {
      tagBatchOptions.push({
        key: 'replace-list',
        label: t('tags.toProperty.replaceList', { value: '[]' }),
        resolution: { kind: 'replace-list' },
      });
    }
    tagBatchOptions.push({ key: 'keep-existing', label: t('tags.toProperty.keepExisting'), resolution: { kind: 'keep-existing' } });
    tagBatchOptions.push({ key: 'skip', label: t('tags.toProperty.skipNote'), resolution: { kind: 'skip' } });
  }
  const activeTagBatch = tagBatchOptions.find(opt => opt.key === batchTagAction) ?? tagBatchOptions[0];
  const tagConflictItems = filtered.filter(item => item.tagAnalysis?.requiresResolution && !item.stale);
  const eligibleTagBatch = activeTagBatch
    ? tagConflictItems.filter(item =>
      (!item.decision.individual || override)
      && item.tagAnalysis!.allowedResolutions.some(res => sameTagResolution(res, activeTagBatch.resolution)),
    )
    : [];
  const ineligibleTagBatchCount = tagConflictItems.length - eligibleTagBatch.length;

  return <Dialog drawer title={t('preview.title')} closeLabel={t('common.close')} onClose={onCancel}>
    <div class="propcraft-drawer-summary" role="status" aria-live="polite">
      <div>{t('scope.filtered', { base: plan.scopeSummary.base.kind === 'all' ? t('scope.all') : plan.scopeSummary.base.path + '/', count: plan.scopeSummary.effective })}</div>
      <div>{t('preview.counts', { ...plan.summary })}</div>
      {plan.summary.conflicts ? <div class="propcraft-warn">{t('preview.conflict', { count: plan.summary.conflicts })}</div> : null}
      <div class="propcraft-muted">{t(`preview.type.${summary.kind}`, { key: summary.targetKey ?? '', type: summary.type ?? '' })}</div>
      {plan.valueSummary ? <div class="propcraft-muted">{t('preview.valueSummary', { ready: plan.valueSummary.ready, confirm: plan.valueSummary.needsConfirmation, unconvertible: plan.valueSummary.unconvertible, noop: plan.valueSummary.noop })}</div> : null}
      <div class="propcraft-muted">{t('preview.yaml')}</div>
      {plan.operation.kind === 'renameTag' || plan.operation.kind === 'mergeTag' ? <div>{t('preview.exactTag')}</div> : null}
      {isTagMigration ? <div class="propcraft-muted">{t('tags.references.unchecked')}</div> : null}
      {plan.operation.kind === 'normalizeDate' ? <div>{t('preview.dateRegion', { target: plan.operation.target, region: plan.operation.regionFormat === 'MDY' ? 'MM/DD/YYYY' : plan.operation.regionFormat === 'DMY' ? 'DD/MM/YYYY' : 'YYYY/MM/DD' })}</div> : null}
      {plan.retryOf ? <div>{t('preview.retry', { id: plan.retryOf })}</div> : null}
      {dataUpdated ? <div>{t('preview.newData')}</div> : null}
      {plan.invalid ? <div class="propcraft-warn" role="alert">{issueText(t, plan.invalid)}</div> : null}
      {busy ? <div>{t('preview.updating')}</div> : null}
    </div>

    {branchSummary ? (
      <div class="propcraft-group propcraft-branch-summary">
        <div class="propcraft-section-title">{t('tags.migrate.mappingsTitle', { count: branchSummary.mappings.length })}</div>
        {branchSummary.overlap ? <div class="propcraft-warn">{t('tags.migrate.overlapWarn')}</div> : null}
        <div class="propcraft-muted">{t('tags.migrate.fmMergeNote')}</div>
        {branchSummary.mappings.length > 0 ? (
          <div class="propcraft-table-wrap">
            <table class="propcraft-table">
              <thead>
                <tr>
                  <th scope="col">{t('tags.migrate.col.from')}</th>
                  <th scope="col">{t('tags.migrate.col.to')}</th>
                  <th scope="col" class="num">{t('tags.migrate.col.notes')}</th>
                  <th scope="col">{t('tags.migrate.col.collision')}</th>
                </tr>
              </thead>
              <tbody>
                {branchSummary.mappings.map(mapping => {
                  const targetIds = new Set(mapping.targets.map(target => target.targetId));
                  const matchingCollisions = branchSummary.collisions.matches.filter(m => targetIds.has(m.targetId));
                  const freshCount = new Set(matchingCollisions.flatMap(m => m.freshPaths)).size;
                  const indexedCount = new Set(matchingCollisions.flatMap(m => m.indexedOtherPaths)).size;
                  return (
                    <tr key={mapping.sourceId}>
                      <td class="propcraft-path">{mapping.sourceVariants.join(', ')}</td>
                      <td class="propcraft-path">{[...new Set(mapping.targets.map(target => target.toRaw))].join(', ')}</td>
                      <td class="num">{mapping.notePaths.length}</td>
                      <td>
                        {freshCount > 0 ? <div>{t('tags.migrate.freshCollision', { count: freshCount })}</div> : null}
                        {indexedCount > 0 ? <div class="propcraft-warn">{t('tags.migrate.indexedCollision', { count: indexedCount })}</div> : null}
                        {freshCount === 0 && indexedCount === 0 ? '—' : null}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        ) : null}
        <div class="propcraft-muted">
          {branchSummary.collisions.indexUnavailable
            ? t('tags.migrate.collisionNoIndex')
            : t('tags.migrate.collisionMeta', {
              rev: branchSummary.collisions.snapshotRevision ?? 0,
              time: branchSummary.collisions.generatedAt ? new Date(branchSummary.collisions.generatedAt).toLocaleTimeString() : '—',
              fresh: branchSummary.collisions.freshCheckedPaths.length,
              indexed: branchSummary.collisions.indexedOnlyCheckedPaths.length,
              unknown: branchSummary.collisions.unknownPaths.length,
            })}
        </div>
        {branchSummary.collisions.unknownPaths.length > 0 ? (
          <div class="propcraft-warn">{t('tags.migrate.collisionUnknown', { count: branchSummary.collisions.unknownPaths.length })}</div>
        ) : null}
        {!branchSummary.collisions.indexUnavailable && branchSummary.collisions.matches.length === 0 ? (
          <div class="propcraft-muted">{t('tags.migrate.collisionNone', { rev: branchSummary.collisions.snapshotRevision ?? 0 })}</div>
        ) : null}
      </div>
    ) : null}

    <div class="propcraft-toolbar"><input class="propcraft-input" placeholder={t('preview.filter')} value={filter} onInput={event => { setFilter(event.currentTarget.value); setLimit(100); }} />
      <select class="propcraft-input" value={group} onChange={event => { setGroup(event.currentTarget.value); setLimit(100); }}><option value="all">{t('preview.all')}</option><option value="conflict">{t('preview.conflicts')}</option><option value="skip">{t('preview.skipped')}</option><option value="blocked">{t('preview.blocked')}</option></select></div>
    <div class="propcraft-toolbar">
      <button class="propcraft-btn" disabled={busy || !selectable.length} onClick={() => onRevise(selectable.map(item => ({ path: item.path, beforeHash: item.decision.beforeHash, selected: true })))}>{t('preview.selectVisible', { count: selectable.length })}</button>
      <button class="propcraft-btn" disabled={busy || !selectable.length} onClick={() => onRevise(selectable.map(item => ({ path: item.path, beforeHash: item.decision.beforeHash, selected: false })))}>{t('preview.deselectVisible')}</button>
    </div>

    {plan.items.some(item => item.allowedStrategies.length > 0) ? <div class="propcraft-toolbar">
      <select class="propcraft-input" value={strategy} onChange={event => setStrategy(event.currentTarget.value as MergeStrategy)}>{(['keep-target', 'keep-source', 'merge-list', 'skip'] as const).map(value => <option value={value} key={value}>{t(`preview.decision.${value}`)}</option>)}</select>
      <label class="propcraft-check"><input type="checkbox" checked={override} onChange={event => setOverride(event.currentTarget.checked)} />{t('preview.decision.override')}</label>
      <button class="propcraft-btn" disabled={busy || !batchConflicts.length} onClick={() => onRevise(batchConflicts.map(item => ({ path: item.path, beforeHash: item.decision.beforeHash, merge: strategy, individual: false })))}>{t('preview.decision.batch')} ({batchConflicts.length})</button>
    </div> : null}

    {plan.operation.kind === 'convertTagsToProperty' && tagConflictItems.length > 0 && activeTagBatch ? (
      <div class="propcraft-toolbar">
        <select
          class="propcraft-input"
          value={activeTagBatch.key}
          onChange={event => setBatchTagAction(event.currentTarget.value)}
        >
          {tagBatchOptions.map(opt => <option value={opt.key} key={opt.key}>{opt.label}</option>)}
        </select>
        <label class="propcraft-check">
          <input type="checkbox" checked={override} onChange={event => setOverride(event.currentTarget.checked)} />
          {t('preview.decision.override')}
        </label>
        <button
          class="propcraft-btn"
          disabled={busy || !eligibleTagBatch.length}
          onClick={() => onRevise(eligibleTagBatch.map(item => ({
            path: item.path,
            beforeHash: item.decision.beforeHash,
            tagPropertyResolution: activeTagBatch.resolution,
            individual: false,
          })))}
        >
          {t('tags.toProperty.batchApply', { eligible: eligibleTagBatch.length, ineligible: ineligibleTagBatchCount })}
        </button>
      </div>
    ) : null}

    <div class="propcraft-drawer-body">{filtered.slice(0, limit).map(item => {
      const tagAnalysis = item.tagAnalysis;
      const activeCandidate = tagAnalysis?.candidates.find(c => c.id === tagAnalysis.selectedCandidateId);
      return <div class="propcraft-diff" key={item.path}>
        <label class="propcraft-check"><input type="checkbox" checked={item.disposition === 'execute'} disabled={busy || item.state !== 'ready' || item.stale} onChange={event => onRevise([{ path: item.path, beforeHash: item.decision.beforeHash, selected: event.currentTarget.checked }])} /><strong class="propcraft-path">{item.path}</strong></label>
        {item.reason ? <div class={item.stale || item.disposition === 'blocked' ? 'propcraft-warn' : 'propcraft-muted'}>{issueText(t, item.reason)}</div> : null}
        {item.reason === 'tag-semantics-changed' ? <div class="propcraft-muted">{t('tags.toProperty.semanticHint')}</div> : null}
        {item.conflictValues ? <div class="propcraft-diff-row"><span>{item.conflictValues.source}</span><span>{item.conflictValues.target}</span></div> : null}
        {tagAnalysis && tagAnalysis.matchedSources.length > 0 ? (
          <div class="propcraft-tag-detail">
            <div class="propcraft-muted">
              {t('tags.toProperty.matchedSources')}: {tagAnalysis.matchedSources.map(s => `${s.variants.join('/')} (${s.origins.join('+')})`).join(', ')}
            </div>
            <div class="propcraft-muted">
              {tagAnalysis.hasExisting
                ? t('tags.toProperty.currentValue', { value: `${displayValue(tagAnalysis.existingValue)} (${tagAnalysis.existingType ?? 'unknown'})` })
                : t('tags.toProperty.missingValue')}
            </div>
            {activeCandidate ? (
              <>
                {!activeCandidate.propertyChanged && activeCandidate.removableRuleIds.length > 0 ? (
                  <div class="propcraft-muted">{t('tags.toProperty.alreadySet')}</div>
                ) : null}
                {activeCandidate.dispositions.map(disp => (
                  <div class="propcraft-muted" key={disp.ruleId}>
                    {disp.tag}: {disp.action === 'remove'
                      ? t('tags.toProperty.willRemove')
                      : disp.reason === 'tag-source-unrepresented'
                        ? t('tags.toProperty.unrepresented')
                        : t('tags.toProperty.retained')}
                  </div>
                ))}
              </>
            ) : null}
          </div>
        ) : null}
        <ConflictEditor item={item} t={t} disabled={busy} onChange={patch => onRevise([patch])} />
        {item.diffs.map((hunk, index) => <div class={`propcraft-diff-row ${hunk.kind === 'del' ? 'is-del' : hunk.kind === 'add' ? 'is-add' : ''}`} key={index}>
          <span class="propcraft-diff-label">{hunk.label === 'body' ? t('diff.body') : hunk.label}</span>
          {hunk.before !== undefined ? <span class="propcraft-diff-before">− {hunk.before}</span> : null}{hunk.after !== undefined ? <span class="propcraft-diff-after">+ {hunk.after}</span> : null}
        </div>)}
        <button class="propcraft-link" onClick={() => void plugin.openNote(item.path)}>{t('scope.open')}</button>
      </div>;
    })}{filtered.length > limit ? <button class="propcraft-btn" onClick={() => setLimit(limit + 100)}>{t('preview.more')}</button> : null}</div>
    <div class="propcraft-drawer-actions">
      <button class="propcraft-btn" onClick={onCancel}>{t('preview.cancel')}</button>
      {plan.invalid || dataUpdated ? <button class="propcraft-btn" disabled={busy} onClick={() => onRebuild()}>{t('preview.rebuild')}</button> : null}
      {plan.items.some(item => item.stale) ? <button class="propcraft-btn" disabled={busy} onClick={() => onRebuild(true)}>{t('preview.stale')}</button> : null}
      <button class="propcraft-btn mod-cta" disabled={busy || Boolean(plan.invalid) || !plan.summary.execute || plugin.coordinator.isBusy()} onClick={onApply}>{t('preview.applyCount', { count: plan.summary.execute })}</button>
    </div>
  </Dialog>;
}
