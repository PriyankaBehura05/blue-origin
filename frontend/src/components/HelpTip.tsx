// Contextual help: a small popover that explains a KPI, chart, filter, column or page on hover or keyboard focus.
// Two forms: <HelpTip text="…" /> draws an ⓘ icon; <HelpTip text="…">label</HelpTip> makes the label itself the
// trigger (dotted underline), for places where an icon would crowd the layout (table headings). `block` wraps an
// element that is focusable itself (a menu link): no underline, no extra tab stop.
// The popover is portalled to <body> with fixed positioning, so scrolling tables and sticky headers never clip it.
import { useCallback, useEffect, useId, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';

type Side = 'bottom' | 'right';
const OPEN_DELAY = 200;
const GAP = 8;
const EDGE = 8;

export function HelpTip({ text, children, side = 'bottom', block }: { text?: ReactNode; children?: ReactNode; side?: Side; block?: boolean }) {
  const id = useId();
  const ref = useRef<HTMLSpanElement>(null);
  const pop = useRef<HTMLDivElement>(null);
  const timer = useRef<number>();
  const [open, setOpen] = useState(false);
  const [pos, setPos] = useState<{ top: number; left: number } | null>(null);

  const show = useCallback(() => {
    window.clearTimeout(timer.current);
    timer.current = window.setTimeout(() => setOpen(true), OPEN_DELAY);
  }, []);
  const hide = useCallback(() => {
    window.clearTimeout(timer.current);
    setOpen(false);
    setPos(null);
  }, []);
  useEffect(() => () => window.clearTimeout(timer.current), []);

  // place below the trigger (or to its right), flip above when there is no room, keep inside the window
  useLayoutEffect(() => {
    if (!open || !ref.current || !pop.current) return;
    const t = ref.current.getBoundingClientRect();
    const p = pop.current.getBoundingClientRect();
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    let top: number;
    let left: number;
    if (side === 'right' && t.right + GAP + p.width <= vw - EDGE) {
      left = t.right + GAP;
      top = t.top + t.height / 2 - p.height / 2;
    } else {
      left = t.left + t.width / 2 - p.width / 2;
      top = t.bottom + GAP;
      if (top + p.height > vh - EDGE && t.top - GAP - p.height >= EDGE) top = t.top - GAP - p.height;
    }
    setPos({ top: Math.max(EDGE, Math.min(top, vh - p.height - EDGE)), left: Math.max(EDGE, Math.min(left, vw - p.width - EDGE)) });
  }, [open, side]);

  // a scroll or a press elsewhere closes it (the position would be stale)
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && hide();
    const onDown = (e: PointerEvent) => !ref.current?.contains(e.target as Node) && hide();
    window.addEventListener('scroll', hide, true);
    window.addEventListener('resize', hide);
    window.addEventListener('keydown', onKey);
    window.addEventListener('pointerdown', onDown);
    return () => {
      window.removeEventListener('scroll', hide, true);
      window.removeEventListener('resize', hide);
      window.removeEventListener('keydown', onKey);
      window.removeEventListener('pointerdown', onDown);
    };
  }, [open, hide]);

  if (!text) return <>{children}</>;
  const icon = children == null;
  return (
    <>
      <span
        ref={ref}
        className={icon ? 'help-i' : `help-target${block ? ' help-block' : ''}`}
        tabIndex={block ? undefined : 0}
        role={icon ? 'button' : undefined}
        aria-label={icon ? 'What is this?' : undefined}
        aria-describedby={open ? id : undefined}
        onMouseEnter={show}
        onMouseLeave={hide}
        onFocus={show}
        onBlur={hide}
        // touch screens have no hover: a tap on the icon toggles it (and must not reach a parent label, sort heading or link)
        onClick={icon ? (e) => { e.preventDefault(); e.stopPropagation(); if (open) hide(); else setOpen(true); } : undefined}
      >
        {icon ? 'i' : children}
      </span>
      {open && createPortal(
        <div ref={pop} id={id} role="tooltip" className="help-pop" style={pos ?? { top: 0, left: 0, visibility: 'hidden' }}>{text}</div>,
        document.body,
      )}
    </>
  );
}
