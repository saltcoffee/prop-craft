import type { ComponentChildren } from 'preact';
import { useEffect, useRef } from 'preact/hooks';

export function Dialog({ title, closeLabel, onClose, children, drawer = false }: {
  title: string; closeLabel: string; onClose?: () => void; children: ComponentChildren; drawer?: boolean;
}) {
  const root = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const element = root.current!;
    const doc = element.ownerDocument, previous = doc.activeElement as HTMLElement | null;
    element.querySelector<HTMLElement>('[data-dialog-title]')?.focus();
    return () => { if (previous?.isConnected) previous.focus(); };
  }, []);
  return <div class={drawer ? 'propcraft-drawer-backdrop' : 'propcraft-overlay'} onClick={event => { if (event.target === event.currentTarget) onClose?.(); }}>
    <div class={drawer ? 'propcraft-drawer' : 'propcraft-dialog'} role="dialog" aria-modal="true" aria-label={title} ref={root} onKeyDown={event => {
      if (event.key === 'Escape' && onClose) { event.preventDefault(); event.stopPropagation(); onClose(); }
      if (event.key !== 'Tab') return;
      const nodes = [...(root.current?.querySelectorAll<HTMLElement>('button:not(:disabled), input:not(:disabled), select:not(:disabled), a[href], [tabindex="0"]') ?? [])].filter(el => el.getClientRects().length);
      const first = nodes[0], last = nodes.at(-1), active = root.current?.ownerDocument.activeElement;
      if (!first) { event.preventDefault(); return; }
      if (event.shiftKey && (active === first || !nodes.includes(active as HTMLElement))) { event.preventDefault(); last?.focus(); }
      else if (!event.shiftKey && (active === last || !nodes.includes(active as HTMLElement))) { event.preventDefault(); first.focus(); }
    }}>
      <div class="propcraft-drawer-head"><strong tabIndex={-1} data-dialog-title>{title}</strong>{onClose ? <button class="propcraft-link" aria-label={closeLabel} onClick={onClose}>✕</button> : null}</div>
      {children}
    </div>
  </div>;
}
