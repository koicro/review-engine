import type { ReactNode } from 'react';
import { en } from '../messages';

export type RouteKey = 'overview' | 'categories' | 'entities' | 'compare' | 'relations' | 'data' | 'settings';

const navigation: Array<{ key: RouteKey; label: string; short: string }> = [
  { key: 'overview', ...en.shell.navigation.overview },
  { key: 'categories', ...en.shell.navigation.categories },
  { key: 'entities', ...en.shell.navigation.entities },
  { key: 'compare', ...en.shell.navigation.compare },
  { key: 'relations', ...en.shell.navigation.relations },
  { key: 'data', ...en.shell.navigation.data },
];

export function Shell({
  route,
  children,
  onNavigate,
}: {
  route: RouteKey;
  children: ReactNode;
  onNavigate: (route: RouteKey) => void;
}) {
  return (
    <div className="app-frame">
      <a
        className="skip-link"
        href="#main-content"
        onClick={(event) => {
          event.preventDefault();
          document.getElementById('main-content')?.focus();
        }}
      >
        {en.shell.skipToContent}
      </a>
      <header className="topbar">
        <a className="brand" href="#/overview" onClick={(event) => { event.preventDefault(); onNavigate('overview'); }}>
          <span className="brand-mark" aria-hidden="true"><i /><i /><i /></span>
          <span>
            <strong>{en.shell.brand}</strong>
            <small>{en.shell.tagline}</small>
          </span>
        </a>
        <nav className="primary-nav" aria-label={en.shell.primaryNavigation}>
          {navigation.map((item) => (
            <a
              key={item.key}
              href={`#/${item.key}`}
              className={route === item.key ? 'active' : ''}
              aria-current={route === item.key ? 'page' : undefined}
              onClick={(event) => { event.preventDefault(); onNavigate(item.key); }}
            >
              {item.label}
            </a>
          ))}
        </nav>
        <a
          href="#/settings"
          className={`settings-link ${route === 'settings' ? 'active' : ''}`}
          aria-label={en.shell.settings}
          aria-current={route === 'settings' ? 'page' : undefined}
          onClick={(event) => { event.preventDefault(); onNavigate('settings'); }}
        >
          <span aria-hidden="true">⚙</span>
          <span>{en.shell.settings}</span>
        </a>
      </header>
      <main id="main-content" className="main-content" tabIndex={-1}>{children}</main>
      <nav className="mobile-nav" aria-label={en.shell.mobileNavigation}>
        {navigation.slice(0, 5).map((item) => (
          <a
            key={item.key}
            href={`#/${item.key}`}
            className={route === item.key ? 'active' : ''}
            aria-current={route === item.key ? 'page' : undefined}
            onClick={(event) => { event.preventDefault(); onNavigate(item.key); }}
          >
            <span aria-hidden="true">{item.key === 'overview' ? '⌂' : item.key === 'categories' ? '▤' : item.key === 'entities' ? '◇' : item.key === 'compare' ? '⇄' : '⌘'}</span>
            <small>{item.short}</small>
          </a>
        ))}
        <a href="#/settings" className={route === 'settings' || route === 'data' ? 'active' : ''} onClick={(event) => { event.preventDefault(); onNavigate('settings'); }}>
          <span aria-hidden="true">⚙</span><small>{en.shell.more}</small>
        </a>
      </nav>
    </div>
  );
}
