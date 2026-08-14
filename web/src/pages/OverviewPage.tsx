import { useEffect, useState } from 'react';
import type { Category, Entity } from '../api/types';
import { useApi } from '../api/context';
import type { RouteKey } from '../components/Shell';
import { Button, Card, EmptyState, ErrorPanel, LoadingState, PageHeader } from '../components/UI';
import { explainError, formatDateTime } from '../lib';
import { en } from '../messages';

export function OverviewPage({ onNavigate }: { onNavigate: (route: RouteKey) => void }) {
  const { api } = useApi();
  const [categories, setCategories] = useState<Category[]>([]);
  const [entities, setEntities] = useState<Entity[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [retry, setRetry] = useState(0);

  useEffect(() => {
    let active = true;
    setLoading(true);
    setError('');
    Promise.all([
      api.listAllCategories({ limit: 100 }),
      api.listEntities({ limit: 6 }),
    ]).then(([allCategories, entityPage]) => {
      if (!active) return;
      setCategories(allCategories);
      setEntities(entityPage.items);
    }).catch((cause) => {
      if (active) setError(explainError(cause));
    }).finally(() => {
      if (active) setLoading(false);
    });
    return () => { active = false; };
  }, [api, retry]);

  return (
    <div className="page-stack">
      <PageHeader
        eyebrow={en.overview.eyebrow}
        title={en.overview.title}
        description={en.overview.description}
        actions={<Button onClick={() => onNavigate(categories.length ? 'entities' : 'categories')}>{categories.length ? en.overview.addEntity : en.overview.createFirstCategory}</Button>}
      />

      {loading && <LoadingState label={en.overview.opening} />}
      {error && <ErrorPanel message={error} onRetry={() => setRetry((value) => value + 1)} />}

      {!loading && !error && categories.length === 0 && (
        <Card className="onboarding-card">
          <div className="onboarding-copy">
            <p className="eyebrow">{en.overview.startHere}</p>
            <h2>{en.overview.designScorecard}</h2>
            <p>{en.overview.categoryExplanation}</p>
            <Button onClick={() => onNavigate('categories')}>{en.overview.setUpCategory}</Button>
          </div>
          <ol className="step-list">
            {en.overview.steps.map((step, index) => <li key={step.title}><span>{index + 1}</span><div><strong>{step.title}</strong><small>{step.description}</small></div></li>)}
          </ol>
        </Card>
      )}

      {!loading && !error && categories.length > 0 && (
        <>
          <section className="stat-grid" aria-label={en.overview.workspaceSummary}>
            <Card><p>{en.overview.categories}</p><strong>{categories.filter((item) => !item.archivedAt).length}</strong><small>{en.overview.readyForReviews(categories.filter((item) => item.activeTemplateVersionId).length)}</small></Card>
            <Card><p>{en.overview.entities}</p><strong>{entities.length}</strong><small>{en.overview.currentResultSet}</small></Card>
            <Card><p>{en.overview.recentActivity}</p><strong>{entities.filter((item) => item.latestReviewedAt).length}</strong><small>{en.overview.recentReviewEntities}</small></Card>
          </section>

          <div className="dashboard-grid">
            <Card>
              <div className="section-heading">
                <div><p className="eyebrow">{en.overview.continue}</p><h2>{en.overview.recentEntities}</h2></div>
                <button className="text-button" onClick={() => onNavigate('entities')}>{en.overview.viewAll}</button>
              </div>
              {entities.length === 0 ? (
                <EmptyState title={en.overview.noEntities} description={en.overview.noEntitiesDescription} action={<Button variant="secondary" onClick={() => onNavigate('entities')}>{en.overview.addEntityShort}</Button>} />
              ) : (
                <ul className="activity-list">
                  {entities.map((entity) => (
                    <li key={entity.id}>
                      <button onClick={() => {
                        window.sessionStorage.setItem('review-engine.selected-entity', entity.id);
                        onNavigate('entities');
                      }}>
                        <span className="entity-monogram" aria-hidden="true">{entity.name.slice(0, 1).toUpperCase()}</span>
                        <span><strong>{entity.name}</strong><small>{entity.category?.name || categories.find((item) => item.id === entity.categoryId)?.name || en.common.entity}</small></span>
                        <time>{formatDateTime(entity.latestReviewedAt || entity.updatedAt)}</time>
                      </button>
                    </li>
                  ))}
                </ul>
              )}
            </Card>

            <Card className="quick-actions-card">
              <div className="section-heading"><div><p className="eyebrow">{en.overview.shortcuts}</p><h2>{en.overview.prompt}</h2></div></div>
              <div className="quick-actions">
                <button onClick={() => onNavigate('entities')}><span aria-hidden="true">＋</span><div><strong>{en.overview.recordReview}</strong><small>{en.overview.recordReviewDescription}</small></div></button>
                <button onClick={() => onNavigate('compare')}><span aria-hidden="true">⇄</span><div><strong>{en.overview.compareEntities}</strong><small>{en.overview.compareDescription}</small></div></button>
                <button onClick={() => onNavigate('relations')}><span aria-hidden="true">⌘</span><div><strong>{en.overview.exploreRelations}</strong><small>{en.overview.exploreDescription}</small></div></button>
              </div>
            </Card>
          </div>
        </>
      )}
    </div>
  );
}
