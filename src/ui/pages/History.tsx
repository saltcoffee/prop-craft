import { useEffect, useState } from 'preact/hooks';
import type { ChangeOperation, JournalMeta } from '../../domain/models';
import type { TextKey } from '../../i18n';
import type { PageProps } from '../types';

const STATUS_KEY: Record<JournalMeta['status'], TextKey> = {
  'in-progress': 'history.status.in-progress',
  committed: 'history.status.committed',
  partial: 'history.status.partial',
  'rolled-back': 'history.status.rolled-back',
};

function describe(operation: ChangeOperation): string {
  switch (operation.kind) {
    case 'renameTag': return `renameTag ${operation.from} → ${operation.to}`;
    case 'mergeTag': return `mergeTag ${operation.from} → ${operation.to}`;
    case 'renameProperty': return `renameProperty ${operation.from} → ${operation.to}`;
    case 'mergeProperty': return `mergeProperty ${operation.from} → ${operation.to}`;
    case 'deleteProperty': return `deleteProperty ${operation.key}`;
    case 'addProperty': return `addProperty ${operation.key} = ${JSON.stringify(operation.value)}`;
    case 'normalizeDate': return `normalizeDate ${operation.key}`;
    default: return 'operation';
  }
}

export function History({ plugin, t }: PageProps) {
  const [metas, setMetas] = useState<JournalMeta[]>([]);

  const load = () => {
    void plugin.journal.list().then(setMetas).catch(() => setMetas([]));
  };
  useEffect(load, [plugin]);

  const undo = async (transactionId: string) => {
    try {
      const result = await plugin.undo(transactionId);
      plugin.notify(t('notice.undone', { count: result.restored.length }));
    } finally {
      load();
    }
  };

  return (
    <div class="propcraft-page">
      <h2 class="propcraft-page-title">{t('history.title')}</h2>
      {metas.length === 0 ? <div class="propcraft-empty">{t('history.empty')}</div> : (
        <div class="propcraft-table-wrap">
          <table class="propcraft-table">
            <thead>
              <tr>
                <th scope="col">{t('history.col.action')}</th>
                <th scope="col">{t('properties.col.files')}</th>
                <th scope="col">{t('history.col.status')}</th>
                <th scope="col">{t('properties.col.actions')}</th>
              </tr>
            </thead>
            <tbody>
              {metas.map(meta => (
                <tr key={meta.transactionId}>
                  <td>{describe(meta.operation)}</td>
                  <td class="num">{meta.fileCount}</td>
                  <td>{t(STATUS_KEY[meta.status])}</td>
                  <td class="propcraft-actions">
                    {meta.status !== 'rolled-back' ? <button class="propcraft-link" onClick={() => void undo(meta.transactionId)}>{t('history.undo')}</button> : null}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
