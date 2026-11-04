import { useEffect, useId, useRef, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { X } from 'lucide-react';

/** Native modal isolation keeps background controls inert for both drawers and confirmations. */
export function Dialog({ title, close, children, dismissible = true, variant = 'modal' }: { title: string; close: () => void; children: ReactNode; dismissible?: boolean; variant?: 'modal' | 'drawer' }) {
  const ref = useRef<HTMLDialogElement>(null), titleId = useId();
  const pressedOutside = useRef(false);
  useEffect(() => {
    const element = ref.current!;
    const previous = document.activeElement as HTMLElement | null;
    element.showModal();
    return () => { element.close(); if (previous?.isConnected) previous.focus(); };
  }, []);
  return createPortal(<dialog ref={ref} tabIndex={-1} className={'modal native-dialog ' + (variant === 'drawer' ? 'detail-drawer' : '')} aria-labelledby={titleId} onPointerDown={event => {
    const bounds = event.currentTarget.getBoundingClientRect();
    pressedOutside.current = event.target === event.currentTarget && (event.clientX < bounds.left || event.clientX > bounds.right || event.clientY < bounds.top || event.clientY > bounds.bottom);
  }} onClick={event => {
    const bounds = event.currentTarget.getBoundingClientRect();
    const outside = event.clientX < bounds.left || event.clientX > bounds.right || event.clientY < bounds.top || event.clientY > bounds.bottom;
    if (dismissible && pressedOutside.current && event.target === event.currentTarget && outside) close();
    pressedOutside.current = false;
  }} onCancel={event => { event.preventDefault(); if (dismissible) close(); }} onKeyDown={event => {
    if (event.key !== 'Tab' || event.defaultPrevented) return;
    // Native modal isolation prevents background interaction; wrap the ends to keep keyboard context here.
    const controls = [...event.currentTarget.querySelectorAll<HTMLElement>('button, a[href], input, select, textarea, summary, [tabindex]')].filter(element => element.tabIndex >= 0 && !element.matches(':disabled') && element.getClientRects().length > 0 && getComputedStyle(element).visibility !== 'hidden');
    const target = event.shiftKey ? controls.at(-1) : controls[0];
    if (!controls.length || event.shiftKey && document.activeElement === controls[0] || !event.shiftKey && document.activeElement === controls.at(-1)) {
      event.preventDefault(); (target ?? event.currentTarget).focus();
    }
  }}>
    <div className="panel-heading"><h2 id={titleId}>{title}</h2><button type="button" aria-label="Close dialog" onClick={close} disabled={!dismissible}><X size={18} /></button></div>
    {variant === 'drawer' ? <div className="drawer-body">{children}</div> : children}
  </dialog>, document.body);
}
