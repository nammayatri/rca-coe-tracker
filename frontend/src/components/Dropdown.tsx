import {
  cloneElement,
  isValidElement,
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
} from 'react';
import type { ReactElement, ReactNode } from 'react';
import { createPortal } from 'react-dom';

interface DropdownProps {
  trigger: ReactNode;
  align?: 'left' | 'right';
  width?: number;
  children: (close: () => void) => ReactNode;
  disabled?: boolean;
  menuClassName?: string;
}

interface Anchor {
  top: number;
  left: number;
  width: number;
}

export default function Dropdown({
  trigger,
  align = 'left',
  width,
  children,
  disabled = false,
  menuClassName = '',
}: DropdownProps) {
  const [open, setOpen] = useState(false);
  const [anchor, setAnchor] = useState<Anchor | null>(null);
  const triggerRef = useRef<HTMLDivElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const menuId = useId();

  const close = useCallback(() => setOpen(false), []);

  // Position the menu by measuring the trigger.
  useLayoutEffect(() => {
    if (!open) return;
    const update = () => {
      const el = triggerRef.current?.firstElementChild as HTMLElement | null;
      if (!el) return;
      const r = el.getBoundingClientRect();
      const measuredWidth = width ?? Math.max(r.width, 180);
      // The menu is position: fixed (viewport-relative). Use viewport coords
      // straight from getBoundingClientRect — do NOT add scrollX/scrollY.
      const left = align === 'right' ? r.right - measuredWidth : r.left;
      setAnchor({
        top: r.bottom + 6,
        left,
        width: measuredWidth,
      });
    };
    update();
    window.addEventListener('resize', update);
    window.addEventListener('scroll', update, true);
    return () => {
      window.removeEventListener('resize', update);
      window.removeEventListener('scroll', update, true);
    };
  }, [open, align, width]);

  // Click outside, ESC, keyboard nav.
  useEffect(() => {
    if (!open) return;
    const onMouseDown = (e: MouseEvent) => {
      const t = e.target as Node;
      if (triggerRef.current?.contains(t)) return;
      if (menuRef.current?.contains(t)) return;
      close();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopPropagation();
        close();
        const focusable = triggerRef.current?.firstElementChild as HTMLElement | null;
        focusable?.focus();
        return;
      }
      if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp' && e.key !== 'Home' && e.key !== 'End') {
        return;
      }
      const root = menuRef.current;
      if (!root) return;
      const items = Array.from(
        root.querySelectorAll<HTMLElement>('[role="menuitem"]:not([aria-disabled="true"])'),
      );
      if (items.length === 0) return;
      e.preventDefault();
      const active = document.activeElement as HTMLElement | null;
      const idx = active ? items.indexOf(active) : -1;
      let next = idx;
      if (e.key === 'ArrowDown') next = idx < 0 ? 0 : (idx + 1) % items.length;
      else if (e.key === 'ArrowUp') next = idx <= 0 ? items.length - 1 : idx - 1;
      else if (e.key === 'Home') next = 0;
      else if (e.key === 'End') next = items.length - 1;
      items[next]?.focus();
    };
    document.addEventListener('mousedown', onMouseDown);
    document.addEventListener('keydown', onKey, true);
    return () => {
      document.removeEventListener('mousedown', onMouseDown);
      document.removeEventListener('keydown', onKey, true);
    };
  }, [open, close]);

  // When opened, focus the first item.
  useEffect(() => {
    if (!open) return;
    const t = window.setTimeout(() => {
      const root = menuRef.current;
      if (!root) return;
      const first = root.querySelector<HTMLElement>('[role="menuitem"]:not([aria-disabled="true"])');
      first?.focus();
    }, 0);
    return () => window.clearTimeout(t);
  }, [open]);

  const onTriggerKeyDown = (e: React.KeyboardEvent) => {
    if (disabled) return;
    if (e.key === 'ArrowDown' || e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      setOpen(true);
    }
  };

  // Decorate the trigger with aria + click + keydown.
  let renderedTrigger: ReactNode = trigger;
  if (isValidElement(trigger)) {
    const el = trigger as ReactElement<Record<string, unknown>>;
    const existingProps = el.props as Record<string, unknown>;
    renderedTrigger = cloneElement(el, {
      'aria-haspopup': 'menu',
      'aria-expanded': open,
      'aria-controls': menuId,
      onClick: (e: React.MouseEvent) => {
        const prev = existingProps.onClick as ((e: React.MouseEvent) => void) | undefined;
        prev?.(e);
        if (e.defaultPrevented) return;
        if (disabled) return;
        setOpen((o) => !o);
      },
      onKeyDown: (e: React.KeyboardEvent) => {
        const prev = existingProps.onKeyDown as ((e: React.KeyboardEvent) => void) | undefined;
        prev?.(e);
        if (e.defaultPrevented) return;
        onTriggerKeyDown(e);
      },
    });
  }

  return (
    <>
      <div ref={triggerRef} className="inline-flex">
        {renderedTrigger}
      </div>
      {open && anchor &&
        createPortal(
          <div
            ref={menuRef}
            id={menuId}
            role="menu"
            style={{ top: anchor.top, left: anchor.left, width: anchor.width }}
            className={`fixed z-[60] bg-white rounded-xl shadow-[0_12px_40px_-8px_rgba(15,23,42,0.18)] ring-1 ring-slate-200/70 p-1 animate-dropdown ${menuClassName}`}
          >
            {children(close)}
          </div>,
          document.body,
        )}
    </>
  );
}

interface DropdownItemProps {
  onSelect?: () => void;
  selected?: boolean;
  disabled?: boolean;
  leading?: ReactNode;
  trailing?: ReactNode;
  danger?: boolean;
  children: ReactNode;
}

export function DropdownItem({
  onSelect,
  selected = false,
  disabled = false,
  leading,
  trailing,
  danger = false,
  children,
}: DropdownItemProps) {
  const ref = useRef<HTMLButtonElement>(null);

  const onKeyDown = (e: React.KeyboardEvent<HTMLButtonElement>) => {
    if (disabled) return;
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      onSelect?.();
    }
  };

  return (
    <button
      ref={ref}
      role="menuitem"
      tabIndex={-1}
      type="button"
      onClick={() => !disabled && onSelect?.()}
      onKeyDown={onKeyDown}
      aria-disabled={disabled || undefined}
      className={`w-full flex items-center gap-2 px-2.5 py-1.5 rounded-lg text-sm text-left transition-colors outline-none ${
        disabled
          ? 'opacity-40 cursor-not-allowed text-slate-500'
          : selected
          ? 'bg-blue-50 text-blue-700'
          : danger
          ? 'text-red-600 hover:bg-red-50 focus-visible:bg-red-50'
          : 'text-slate-700 hover:bg-slate-100 focus-visible:bg-slate-100'
      }`}
    >
      {leading && <span className="shrink-0 inline-flex items-center justify-center w-4 h-4">{leading}</span>}
      <span className="flex-1 truncate">{children}</span>
      {trailing && <span className="shrink-0 inline-flex items-center">{trailing}</span>}
    </button>
  );
}
