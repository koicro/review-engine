import { useEffect, useState } from 'react';
import { useApi } from './api/context';
import { Shell, type RouteKey } from './components/Shell';
import { CategoriesPage } from './pages/CategoriesPage';
import { ComparePage } from './pages/ComparePage';
import { DataPage } from './pages/DataPage';
import { EntitiesPage } from './pages/EntitiesPage';
import { OverviewPage } from './pages/OverviewPage';
import { RelationsPage } from './pages/RelationsPage';
import { SettingsPage } from './pages/SettingsPage';
import { LoadingState } from './components/UI';
import { en } from './messages';

const routes = new Set<RouteKey>(['overview', 'categories', 'entities', 'compare', 'relations', 'data', 'settings']);

function routeFromHash(): RouteKey {
  const route = window.location.hash.replace(/^#\/?/, '').split('/')[0] as RouteKey;
  return routes.has(route) ? route : 'overview';
}

export default function App() {
  const { sessionStatus } = useApi();
  const [route, setRoute] = useState<RouteKey>(routeFromHash);
  const needsAuthentication = sessionStatus !== 'checking' && sessionStatus !== 'authenticated' && route !== 'settings';
  const activeRoute = needsAuthentication ? 'settings' : route;

  useEffect(() => {
    function syncRoute() {
      setRoute(routeFromHash());
      window.scrollTo({ top: 0, behavior: 'smooth' });
    }
    window.addEventListener('hashchange', syncRoute);
    if (!window.location.hash) window.history.replaceState(null, '', '#/overview');
    return () => window.removeEventListener('hashchange', syncRoute);
  }, []);

  useEffect(() => {
    if (needsAuthentication) window.location.hash = '#/settings';
  }, [needsAuthentication]);

  function navigate(next: RouteKey) {
    const nextHash = `#/${next}`;
    if (window.location.hash === nextHash) {
      setRoute(next);
      window.scrollTo({ top: 0, behavior: 'smooth' });
      return;
    }
    window.location.hash = nextHash;
  }

  if (sessionStatus === 'checking' && route !== 'settings') {
    return (
      <Shell route="settings" onNavigate={navigate}>
        <LoadingState label={en.app.checkingSession} />
      </Shell>
    );
  }

  return (
    <Shell route={activeRoute} onNavigate={navigate}>
      {activeRoute === 'overview' && <OverviewPage onNavigate={navigate} />}
      {activeRoute === 'categories' && <CategoriesPage />}
      {activeRoute === 'entities' && <EntitiesPage />}
      {activeRoute === 'compare' && <ComparePage />}
      {activeRoute === 'relations' && <RelationsPage />}
      {activeRoute === 'data' && <DataPage />}
      {activeRoute === 'settings' && <SettingsPage />}
    </Shell>
  );
}
