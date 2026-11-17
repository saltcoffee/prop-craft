import type { PreviewDecisionPatch, PreviewItem } from '../../domain/preview';
import type { MergeStrategy } from '../../domain/models';
import type { Translate } from '../../i18n';
export function ConflictEditor({ item, t, disabled, onChange }: { item: PreviewItem; t: Translate; disabled: boolean; onChange: (patch: PreviewDecisionPatch) => void }) {
  const required = item.valueAnalysis?.requiredConfirmations ?? [];
  return <>
    {item.allowedStrategies.length ? <select class="propcraft-input" aria-label={`${t('preview.conflicts')}: ${item.path}`} disabled={disabled || item.stale} value={item.decision.merge ?? ''} onChange={event => {
      const merge = event.currentTarget.value as MergeStrategy;
      if (merge) onChange({ path: item.path, beforeHash: item.decision.beforeHash, merge, selected: merge !== 'skip', individual: true });
    }}>
      <option value="">{t('preview.decision.none')}</option>
      {item.allowedStrategies.map(strategy => <option value={strategy} key={strategy}>{t(`preview.decision.${strategy}`)}</option>)}
    </select> : null}
    {(item.ambiguousDate || required.includes('date-interpretation')) ? <label class="propcraft-check"><input type="checkbox" disabled={disabled || item.stale} checked={Boolean(item.decision.dateInterpretationConfirmed)} onChange={event => onChange({ path: item.path, beforeHash: item.decision.beforeHash, dateInterpretationConfirmed: event.currentTarget.checked })} />{t('preview.confirmDate', { date: item.ambiguousDate ?? String(item.valueAnalysis?.candidate ?? '') })}</label> : null}
    {required.includes('value-loss') ? <label class="propcraft-check">
      <input type="checkbox" disabled={disabled || item.stale} checked={Boolean(item.decision.valueLossConfirmed)} onChange={event => onChange({ path: item.path, beforeHash: item.decision.beforeHash, valueLossConfirmed: event.currentTarget.checked })} />
      {t('preview.confirmValueLoss')} — <span class="propcraft-muted">{t('preview.valueLoss')}</span>
    </label> : null}
    {required.includes('declared-type-mismatch') ? <label class="propcraft-check">
      <input type="checkbox" disabled={disabled || item.stale} checked={Boolean(item.decision.declaredTypeMismatchConfirmed)} onChange={event => onChange({ path: item.path, beforeHash: item.decision.beforeHash, declaredTypeMismatchConfirmed: event.currentTarget.checked })} />
      {t('preview.confirmDeclared')}
    </label> : null}
  </>;
}
