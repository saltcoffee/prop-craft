import type { PreviewDecisionPatch, PreviewItem } from '../../domain/preview';
import type { MergeStrategy } from '../../domain/models';
import type { Translate } from '../../i18n';
export function ConflictEditor({ item, t, disabled, onChange }: { item: PreviewItem; t: Translate; disabled: boolean; onChange: (patch: PreviewDecisionPatch) => void }) {
  return <>
    {item.allowedStrategies.length ? <select class="propcraft-input" aria-label={`${t('preview.conflicts')}: ${item.path}`} disabled={disabled || item.stale} value={item.decision.merge ?? ''} onChange={event => {
      const merge = event.currentTarget.value as MergeStrategy;
      if (merge) onChange({ path: item.path, beforeHash: item.decision.beforeHash, merge, selected: merge !== 'skip', individual: true });
    }}>
      <option value="">{t('preview.decision.none')}</option>
      {item.allowedStrategies.map(strategy => <option value={strategy} key={strategy}>{t(`preview.decision.${strategy}`)}</option>)}
    </select> : null}
    {item.ambiguousDate ? <label class="propcraft-check"><input type="checkbox" disabled={disabled || item.stale} checked={Boolean(item.decision.dateInterpretationConfirmed)} onChange={event => onChange({ path: item.path, beforeHash: item.decision.beforeHash, dateInterpretationConfirmed: event.currentTarget.checked, selected: event.currentTarget.checked })} />{t('preview.confirmDate', { date: item.ambiguousDate })}</label> : null}
  </>;
}
