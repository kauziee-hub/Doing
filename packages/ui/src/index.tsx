import type { ButtonHTMLAttributes, ReactNode } from 'react';

/**
 * Small, accessible UI primitives. Styling lives in the desktop app's design
 * tokens (`vc-*` classes) so the overlay and dashboard stay visually consistent.
 */

export function cx(...parts: Array<string | false | null | undefined>): string {
  return parts.filter(Boolean).join(' ');
}

type Variant = 'primary' | 'secondary' | 'ghost' | 'danger';

export function Button({
  variant = 'secondary',
  size = 'md',
  icon,
  children,
  className,
  ...rest
}: ButtonHTMLAttributes<HTMLButtonElement> & { variant?: Variant; size?: 'sm' | 'md'; icon?: ReactNode }) {
  return (
    <button type="button" className={cx('vc-btn', `vc-btn--${variant}`, size === 'sm' && 'vc-btn--sm', className)} {...rest}>
      {icon ? <span className="vc-btn__icon" aria-hidden="true">{icon}</span> : null}
      {children ? <span>{children}</span> : null}
    </button>
  );
}

export function Badge({ tone = 'neutral', children, title }: { tone?: 'neutral' | 'ok' | 'warn' | 'error' | 'info' | 'live'; children: ReactNode; title?: string }) {
  return (
    <span className={cx('vc-badge', `vc-badge--${tone}`)} title={title}>
      {children}
    </span>
  );
}

export function Toggle({ checked, onChange, label, description, disabled }: { checked: boolean; onChange: (v: boolean) => void; label: string; description?: string; disabled?: boolean }) {
  return (
    <label className={cx('vc-toggle', disabled && 'is-disabled')}>
      <span className="vc-toggle__text">
        <span className="vc-toggle__label">{label}</span>
        {description ? <span className="vc-toggle__desc">{description}</span> : null}
      </span>
      <input type="checkbox" role="switch" checked={checked} disabled={disabled} onChange={(e) => onChange(e.target.checked)} />
      <span className="vc-toggle__track" aria-hidden="true">
        <span className="vc-toggle__thumb" />
      </span>
    </label>
  );
}

/** Level meter: -60..0 dBFS mapped to width. */
export function LevelMeter({ db, label }: { db: number; label: string }) {
  const pct = Math.max(0, Math.min(100, ((db + 60) / 60) * 100));
  return (
    <div className="vc-meter" role="meter" aria-label={label} aria-valuemin={-60} aria-valuemax={0} aria-valuenow={Math.round(Math.max(-60, db))}>
      <div className={cx('vc-meter__fill', db > -6 && 'is-hot')} style={{ width: `${pct}%` }} />
    </div>
  );
}

export function Field({ label, hint, children, htmlFor }: { label: string; hint?: ReactNode; children: ReactNode; htmlFor?: string }) {
  return (
    <div className="vc-field">
      <label className="vc-field__label" htmlFor={htmlFor}>
        {label}
      </label>
      {children}
      {hint ? <div className="vc-field__hint">{hint}</div> : null}
    </div>
  );
}

export function Card({ title, actions, children, className }: { title?: ReactNode; actions?: ReactNode; children: ReactNode; className?: string }) {
  return (
    <section className={cx('vc-card', className)}>
      {title || actions ? (
        <header className="vc-card__head">
          {title ? <h3 className="vc-card__title">{title}</h3> : <span />}
          {actions ? <div className="vc-card__actions">{actions}</div> : null}
        </header>
      ) : null}
      {children}
    </section>
  );
}

export function EmptyState({ icon, title, children, action }: { icon?: ReactNode; title: string; children?: ReactNode; action?: ReactNode }) {
  return (
    <div className="vc-empty">
      {icon ? <div className="vc-empty__icon" aria-hidden="true">{icon}</div> : null}
      <div className="vc-empty__title">{title}</div>
      {children ? <div className="vc-empty__body">{children}</div> : null}
      {action ? <div className="vc-empty__action">{action}</div> : null}
    </div>
  );
}
