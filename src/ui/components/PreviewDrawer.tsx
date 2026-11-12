import { useState } from 'preact/hooks';
import type { ChangePlan } from '../../domain/models';
import { diffForFile } from '../../domain/diff';
import type { Translate } from '../../i18n';

interface Props {
  plan: ChangePlan;
  t: Translate;
  onApply: () => void;
  onCancel: () => void;
}

export function PreviewDrawer({ plan, t, onApply, onCancel }: Props) {
  const [filter, setFilter] = useState('');
  const [limit, setLimit] = useState(100);
  const filtered = plan.fileChanges.filter(change => change.path.toLowerCase().includes(filter.toLowerCase()));
  const changes = filtered.slice(0, limit);
  const { summary } = plan;

  return (
    <div class="propcraft-drawer-backdrop" onClick={onCancel}>
      <div class="propcraft-drawer" onClick={event => event.stopPropagation()}>
        <div class="propcraft-drawer-head">
          <strong>{t('preview.title')}</strong>
          <button class="propcraft-link" onClick={onCancel}>✕</button>
        </div>
        <div class="propcraft-drawer-summary">
          <div>{t('preview.affected', { count: summary.willChange })}</div>
          {summary.willSkip > 0 ? <div class="propcraft-muted">{t('preview.skip', { count: summary.willSkip })}</div> : null}
          {summary.conflicts > 0 ? <div class="propcraft-warn">{t('preview.conflict', { count: summary.conflicts })}</div> : null}
        </div>
        <input class="propcraft-input" placeholder={t('preview.filter')} value={filter} onInput={event => setFilter((event.target as HTMLInputElement).value)} />
        <div class="propcraft-drawer-body">
          {summary.willChange === 0 ? <div class="propcraft-empty">{t('preview.nothing')}</div> : changes.map(change => {
            const hunks = diffForFile(change);
            return (
              <div class="propcraft-diff" key={change.path}>
                <div class="propcraft-diff-path">{change.path}</div>
                {hunks.map((hunk, index) => (
                  <div class={`propcraft-diff-row ${hunk.kind === 'del' ? 'is-del' : hunk.kind === 'add' ? 'is-add' : ''}`} key={`${change.path}-${index}`}>
                    <span class="propcraft-diff-label">{hunk.label}</span>
                    {hunk.before !== undefined ? <span class="propcraft-diff-before">- {hunk.before}</span> : null}
                    {hunk.after !== undefined ? <span class="propcraft-diff-after">+ {hunk.after}</span> : null}
                  </div>
                ))}
              </div>
            );
          })}
          {filtered.length > limit ? (
            <button class="propcraft-btn" onClick={() => setLimit(limit + 200)}>{t('preview.more')}</button>
          ) : null}
        </div>
        <div class="propcraft-drawer-actions">
          <button class="propcraft-btn" onClick={onCancel}>{t('preview.cancel')}</button>
          <button class="propcraft-btn mod-cta" disabled={summary.willChange === 0} onClick={onApply}>{t('preview.apply')}</button>
        </div>
      </div>
    </div>
  );
}
