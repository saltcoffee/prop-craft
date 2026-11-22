import type { PreviewDecisionPatch, PreviewItem, TagPropertyResolution } from '../../domain/preview';
import type { MergeStrategy } from '../../domain/models';
import type { Translate } from '../../i18n';
import { displayValue } from '../value-format';

function encodeResolution(res: TagPropertyResolution | undefined): string {
  if (!res) return '';
  if (res.kind === 'use-mapped') return `use:${res.ruleId}`;
  return res.kind;
}

function decodeResolution(encoded: string): TagPropertyResolution | null {
  if (!encoded) return null;
  if (encoded.startsWith('use:')) return { kind: 'use-mapped', ruleId: encoded.slice(4) };
  if (encoded === 'replace-list') return { kind: 'replace-list' };
  if (encoded === 'keep-existing') return { kind: 'keep-existing' };
  if (encoded === 'skip') return { kind: 'skip' };
  return null;
}

export function ConflictEditor({ item, t, disabled, onChange }: { item: PreviewItem; t: Translate; disabled: boolean; onChange: (patch: PreviewDecisionPatch) => void }) {
  const required = item.valueAnalysis?.requiredConfirmations ?? [];
  const tagAnalysis = item.tagAnalysis;

  const resolutionLabel = (res: TagPropertyResolution): string => {
    if (res.kind === 'keep-existing') return t('tags.toProperty.keepExisting');
    if (res.kind === 'skip') return t('tags.toProperty.skipNote');
    if (res.kind === 'replace-list') {
      const cand = tagAnalysis?.candidates.find(c => c.resolution.kind === 'replace-list');
      return t('tags.toProperty.replaceList', { value: displayValue(cand?.value) });
    }
    const source = tagAnalysis?.matchedSources.find(s => s.ruleId === res.ruleId);
    const cand = tagAnalysis?.candidates.find(c => c.ruleIds.includes(res.ruleId));
    return t('tags.toProperty.useMapped', {
      value: displayValue(cand?.value ?? source?.value.value),
      tag: source?.tag ?? res.ruleId,
    });
  };

  return <>
    {item.allowedStrategies.length ? <select class="propcraft-input" disabled={disabled || item.stale} value={item.decision.merge ?? ''} onChange={event => {
      const merge = event.currentTarget.value as MergeStrategy;
      if (merge) onChange({ path: item.path, beforeHash: item.decision.beforeHash, merge, individual: true });
    }}>
      <option value="">{t('preview.decision.none')}</option>
      {item.allowedStrategies.map(strategy => <option value={strategy} key={strategy}>{t(`preview.decision.${strategy}`)}</option>)}
    </select> : null}

    {tagAnalysis && tagAnalysis.requiresResolution && tagAnalysis.allowedResolutions.length > 0 ? (
      <div class="propcraft-tag-decision">
        <select
          class="propcraft-input"
          disabled={disabled || item.stale}
          value={encodeResolution(item.decision.tagPropertyResolution)}
          onChange={event => {
            const decoded = decodeResolution(event.currentTarget.value);
            onChange({
              path: item.path,
              beforeHash: item.decision.beforeHash,
              tagPropertyResolution: decoded,
              individual: decoded !== null,
            });
          }}
        >
          <option value="">{t('preview.decision.none')}</option>
          {tagAnalysis.allowedResolutions.map(res => {
            const key = encodeResolution(res);
            return <option value={key} key={key}>{resolutionLabel(res)}</option>;
          })}
        </select>
        {item.decision.tagPropertyResolution ? (
          <button
            type="button"
            class="propcraft-link"
            disabled={disabled || item.stale}
            onClick={() => onChange({
              path: item.path,
              beforeHash: item.decision.beforeHash,
              tagPropertyResolution: null,
              individual: false,
            })}
          >
            {t('tags.toProperty.withdraw')}
          </button>
        ) : null}
      </div>
    ) : null}

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
