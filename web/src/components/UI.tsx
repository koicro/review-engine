import {
  useEffect,
  useId,
  useRef,
  type ButtonHTMLAttributes,
  type ReactNode,
} from 'react';
import { en } from '../messages';

const focusableSelector = [
  'a[href]',
  'button:not([disabled])',
  'input:not([disabled]):not([type="hidden"])',
  'select:not([disabled])',
  'textarea:not([disabled])',
  '[tabindex]:not([tabindex="-1"])',
].join(',');

export function PageHeader({
  eyebrow,
  title,
  description,
  actions,
}: {
  eyebrow?: string;
  title: string;
  description?: string;
  actions?: ReactNode;
}) {
  return (
    <header className="page-header">
      <div>
        {eyebrow && <p className="eyebrow">{eyebrow}</p>}
        <h1>{title}</h1>
        {description && <p className="page-description">{description}</p>}
      </div>
      {actions && <div className="page-actions">{actions}</div>}
    </header>
  );
}

export function Card({ children, className = '' }: { children: ReactNode; className?: string }) {
  return <section className={`card ${className}`.trim()}>{children}</section>;
}

export function Button({
  variant = 'primary',
  className = '',
  ...props
}: ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: 'primary' | 'secondary' | 'quiet' | 'danger';
}) {
  return <button className={`button button-${variant} ${className}`.trim()} {...props} />;
}

export function Badge({
  children,
  tone = 'neutral',
}: {
  children: ReactNode;
  tone?: 'neutral' | 'success' | 'warning' | 'danger' | 'info';
}) {
  return <span className={`badge badge-${tone}`}>{children}</span>;
}

export function LoadingState({ label = en.common.loading }: { label?: string }) {
  return (
    <div className="state-block" role="status">
      <span className="spinner" aria-hidden="true" />
      <span>{label}…</span>
    </div>
  );
}

export function ErrorPanel({ message, onRetry }: { message: string; onRetry?: () => void }) {
  const needsAuthentication = /unauthori[sz]ed|authentication|access token|forbidden/i.test(message);
  return (
    <div className="error-panel" role="alert">
      <div>
        <strong>{en.ui.requestFailed}</strong>
        <p>{message}</p>
      </div>
      <div className="error-actions">
        {needsAuthentication && <a className="button button-secondary" href="#/settings">{en.ui.openSettings}</a>}
        {onRetry && <Button variant="secondary" onClick={onRetry}>{en.ui.tryAgain}</Button>}
      </div>
    </div>
  );
}

export function EmptyState({
  title,
  description,
  action,
}: {
  title: string;
  description: string;
  action?: ReactNode;
}) {
  return (
    <div className="empty-state">
      <span className="empty-mark" aria-hidden="true">+</span>
      <h3>{title}</h3>
      <p>{description}</p>
      {action}
    </div>
  );
}

export function Field({
  label,
  hint,
  error,
  children,
  required,
}: {
  label: string;
  hint?: string;
  error?: string;
  children: ReactNode;
  required?: boolean;
}) {
  return (
    <label className={`field ${error ? 'field-error' : ''}`}>
      <span className="field-label">{label}{required && <span aria-hidden="true"> *</span>}</span>
      {children}
      {hint && !error && <span className="field-hint">{hint}</span>}
      {error && <span className="field-message">{error}</span>}
    </label>
  );
}

export function Dialog({
  open,
  title,
  description,
  children,
  onClose,
  size = 'medium',
}: {
  open: boolean;
  title: string;
  description?: string;
  children: ReactNode;
  onClose: () => void;
  size?: 'small' | 'medium' | 'large';
}) {
  const titleId = useId();
  const descriptionId = useId();
  const closeRef = useRef<HTMLButtonElement>(null);
  const dialogRef = useRef<HTMLElement>(null);
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;

  useEffect(() => {
    if (!open) return;
    const previous = document.activeElement as HTMLElement | null;
    closeRef.current?.focus();
    function onKeyDown(event: KeyboardEvent) {
      if (event.key === 'Escape') {
        event.preventDefault();
        onCloseRef.current();
        return;
      }
      if (event.key !== 'Tab') return;

      const dialog = dialogRef.current;
      if (!dialog) return;
      const focusable = Array.from(dialog.querySelectorAll<HTMLElement>(focusableSelector))
        .filter((element) => element.getAttribute('aria-hidden') !== 'true');
      if (focusable.length === 0) {
        event.preventDefault();
        dialog.focus();
        return;
      }

      const first = focusable[0]!;
      const last = focusable[focusable.length - 1]!;
      const active = document.activeElement;
      if (event.shiftKey && (active === first || !dialog.contains(active))) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && (active === last || !dialog.contains(active))) {
        event.preventDefault();
        first.focus();
      }
    }
    document.addEventListener('keydown', onKeyDown);
    document.body.classList.add('dialog-open');
    return () => {
      document.removeEventListener('keydown', onKeyDown);
      document.body.classList.remove('dialog-open');
      const restoreTarget = previous?.isConnected
        ? previous
        : document.getElementById('main-content');
      restoreTarget?.focus();
    };
  }, [open]);

  if (!open) return null;
  return (
    <div className="dialog-backdrop" role="presentation" onMouseDown={(event) => {
      if (event.currentTarget === event.target) onClose();
    }}>
      <section
        ref={dialogRef}
        className={`dialog dialog-${size}`}
        role="dialog"
        tabIndex={-1}
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={description ? descriptionId : undefined}
      >
        <header className="dialog-header">
          <div>
            <h2 id={titleId}>{title}</h2>
            {description && <p id={descriptionId}>{description}</p>}
          </div>
          <button ref={closeRef} className="icon-button" onClick={onClose} aria-label={en.ui.closeDialog}>×</button>
        </header>
        <div className="dialog-body">{children}</div>
      </section>
    </div>
  );
}

export function Notice({
  children,
  tone = 'info',
}: {
  children: ReactNode;
  tone?: 'info' | 'success' | 'warning';
}) {
  return <div className={`notice notice-${tone}`} role="status">{children}</div>;
}
