import { useState } from 'preact/hooks';
import type { RecoveryPreview } from '../../domain/recovery';
import type { Translate } from '../../i18n';
import type PropCraftPlugin from '../../main';
import { Dialog } from './Dialog';
import { issueText } from '../text';
export function RecoveryDrawer({ preview, t, plugin, onRecover, onClose, onRecheck }: {
  preview: RecoveryPreview; t: Translate; plugin: PropCraftPlugin; onRecover: () => void; onClose: () => void; onRecheck: () => void;
}) {
  const [filter, setFilter] = useState(''), [limit, setLimit] = useState(100), [original, setOriginal] = useState<{ path: string; content: string } | null>(null);
  const counts = (kind: string) => preview.items.filter(item => item.kind === kind).length;
  const rows = preview.items.filter(item => item.path.toLowerCase().includes(filter.toLowerCase()));
  const readOriginal = async (path: string) => {
    const loaded = await plugin.journal.get(preview.transactionId);
    if (loaded.kind !== 'v2' && loaded.kind !== 'legacy') return;
    const entry = loaded.transaction.entries.find(entry => entry.path === path);
    if (entry) setOriginal({ path, content: entry.beforeContent });
  };
  return <Dialog drawer title={t('history.recovery.title')} closeLabel={t('common.close')} onClose={onClose}>
    <div class="propcraft-drawer-summary">
      <div role="status">{t('history.recovery.counts', { restore: counts('restore'), original: counts('original'), restored: counts('restored'), blocked: counts('blocked'), notApplied: counts('not-applied') })}</div>
      {preview.legacy ? <div>{t('history.legacy')}</div> : null}
      {preview.evidenceIssue ? <div class="propcraft-warn">{issueText(t, preview.evidenceIssue)}</div> : null}
      {preview.canConfirmOriginal ? <div>{t('history.recovery.originalOnly')}</div> : null}
      <div>{t('execute.type', { status: preview.type.targetKey ? `${preview.type.targetKey}: ${preview.type.value}` : t('state.none') })} · {preview.type.reason ? issueText(t, preview.type.reason) : preview.type.kind === 'restore' ? t('history.undo') : preview.type.kind === 'original' ? t('issue.already-original') : t('state.none')}</div>
      <div class="propcraft-muted">{t('history.recovery.dependency')}</div>
    </div>
    <input class="propcraft-input" aria-label={t('preview.filter')} placeholder={t('preview.filter')} value={filter} onInput={event => { setFilter(event.currentTarget.value); setLimit(100); }} />
    <div class="propcraft-drawer-body">{rows.slice(0, limit).map(item => <div class="propcraft-diff" key={item.path}>
      <div class="propcraft-path">{item.path}</div><div class={item.kind === 'blocked' ? 'propcraft-warn' : 'propcraft-muted'}>{issueText(t, item.reason)}</div>
      <button class="propcraft-link" onClick={() => void plugin.openNote(item.path)}>{t('scope.open')}</button>{' '}
      <button class="propcraft-link" onClick={() => void readOriginal(item.path).catch(() => plugin.notify(t('issue.journal-unavailable')))}>{t('history.original')}</button>
    </div>)}{rows.length > limit ? <button class="propcraft-btn" onClick={() => setLimit(limit + 100)}>{t('preview.more')}</button> : null}
    {original ? <details open><summary>{t('history.original')}: {original.path}</summary><pre class="propcraft-original">{original.content}</pre></details> : null}</div>
    <div class="propcraft-drawer-actions"><button class="propcraft-btn" onClick={onClose}>{t('common.close')}</button><button class="propcraft-btn" onClick={onRecheck}>{t('history.recovery.recheck')}</button>
      <button class="propcraft-btn mod-cta" disabled={Boolean(preview.evidenceIssue) && !preview.canConfirmOriginal || !(preview.items.some(item => item.kind !== 'blocked') || preview.type.kind === 'restore' || preview.type.kind === 'original')} onClick={onRecover}>{counts('restore') || preview.type.kind === 'restore' ? t('history.recovery.apply', { count: counts('restore') }) : t('history.recovery.confirmState')}</button></div>
  </Dialog>;
}
