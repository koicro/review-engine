import { useEffect, useMemo, useState, type FormEvent } from 'react';
import { useApi } from '../api/context';
import type { Aggregation, Category, ComparisonResponse, Entity } from '../api/types';
import { Badge, Button, Card, EmptyState, ErrorPanel, Field, LoadingState, PageHeader } from '../components/UI';
import { explainError, formatDateTime, formatScore } from '../lib';
import { en } from '../messages';

const maxComparedEntities = 100;

export function ComparePage() {
  const { api } = useApi();
  const [categories, setCategories] = useState<Category[]>([]);
  const [categoryId, setCategoryId] = useState('');
  const [entities, setEntities] = useState<Entity[]>([]);
  const [selectedIds, setSelectedIds] = useState<string[]>([]);
  const [aggregation, setAggregation] = useState<Aggregation>('latest');
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [result, setResult] = useState<ComparisonResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [comparing, setComparing] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    let active = true;
    setLoading(true);
    api.listAllCategories({ limit: 100 }).then((items) => {
      if (!active) return;
      const available = items.filter((category) => !category.archivedAt);
      setCategories(available);
      setCategoryId((current) => current || available[0]?.id || '');
    }).catch((cause) => active && setError(explainError(cause))).finally(() => active && setLoading(false));
    return () => { active = false; };
  }, [api]);

  useEffect(() => {
    if (!categoryId) { setEntities([]); return; }
    let active = true;
    setLoading(true); setResult(null); setSelectedIds([]); setError('');
    api.listAllEntities({ categoryId, limit: 100 }).then((items) => {
      if (!active) return;
      const available = items.filter((entity) => !entity.archivedAt);
      setEntities(available);
      setSelectedIds(available.slice(0, 4).map((entity) => entity.id));
    }).catch((cause) => active && setError(explainError(cause))).finally(() => active && setLoading(false));
    return () => { active = false; };
  }, [api, categoryId]);

  async function compare(event: FormEvent) {
    event.preventDefault();
    if (selectedIds.length < 2) return;
    setComparing(true); setError('');
    try {
      const response = await api.compare({
        categoryId,
        entityIds: selectedIds,
        aggregation,
        from: from ? new Date(`${from}T00:00:00`).toISOString() : undefined,
        to: to ? new Date(`${to}T23:59:59.999`).toISOString() : undefined,
      });
      setResult(response);
    } catch (cause) { setError(explainError(cause)); }
    finally { setComparing(false); }
  }

  const criteria = useMemo(() => {
    if (!result) return [];
    if (result.criteria?.length) return [...result.criteria].sort((a, b) => a.position - b.position).map((item) => ({ id: item.id, name: item.name }));
    const map = new Map<string, string>();
    result.entities.forEach((entity) => entity.criteria.forEach((criterion) => map.set(criterion.criterionId, criterion.name)));
    return [...map].map(([id, name]) => ({ id, name }));
  }, [result]);

  return (
    <div className="page-stack">
      <PageHeader eyebrow={en.compare.eyebrow} title={en.compare.title} description={en.compare.description} />
      {error && <ErrorPanel message={error} />}
      <form className="compare-layout" onSubmit={compare}>
        <Card className="compare-controls">
          <div className="section-heading"><div><p className="eyebrow">{en.compare.scope}</p><h2>{en.compare.chooseEntities}</h2></div><Badge tone={selectedIds.length >= 2 ? 'success' : 'warning'}>{en.compare.selected(selectedIds.length)}</Badge></div>
          <Field label={en.compare.category}><select value={categoryId} onChange={(event) => setCategoryId(event.target.value)}><option value="" disabled>{en.compare.selectCategory}</option>{categories.map((category) => <option key={category.id} value={category.id}>{category.name}</option>)}</select></Field>
          {loading ? <LoadingState label={en.compare.loadingEntities} /> : entities.length === 0 ? <EmptyState title={en.compare.nothingToCompare} description={en.compare.nothingDescription} /> : (
            <>
              <div className="select-actions"><button type="button" className="text-button" onClick={() => setSelectedIds(entities.slice(0, maxComparedEntities).map((entity) => entity.id))}>{en.compare.selectUpTo(maxComparedEntities)}</button><button type="button" className="text-button" onClick={() => setSelectedIds([])}>{en.common.actions.clear}</button></div>
              <div className="entity-check-list">
                {entities.map((entity) => {
                  const selected = selectedIds.includes(entity.id);
                  return <label key={entity.id}><input type="checkbox" checked={selected} disabled={!selected && selectedIds.length >= maxComparedEntities} onChange={(event) => setSelectedIds((ids) => event.target.checked ? ids.length < maxComparedEntities ? [...ids, entity.id] : ids : ids.filter((id) => id !== entity.id))} /><span className="entity-monogram" aria-hidden="true">{entity.name.slice(0, 1).toUpperCase()}</span><span><strong>{entity.name}</strong><small>{en.compare.reviewCount(entity.reviewCount ?? '—')}</small></span></label>;
                })}
              </div>
              {entities.length > maxComparedEntities && <p className="field-hint centered">{en.compare.chooseLimit(maxComparedEntities, entities.length)}</p>}
            </>
          )}
          <hr />
          <div className="section-heading"><div><p className="eyebrow">{en.compare.projection}</p><h2>{en.compare.setView}</h2></div></div>
          <fieldset className="segmented-field"><legend>{en.compare.aggregation}</legend>{(['latest', 'mean', 'history'] as Aggregation[]).map((value) => <label key={value}><input type="radio" name="aggregation" value={value} checked={aggregation === value} onChange={() => setAggregation(value)} /><span>{en.compare.aggregationLabel(value)}</span></label>)}</fieldset>
          <div className="form-grid two-column"><Field label={en.compare.from}><input type="date" value={from} onChange={(event) => setFrom(event.target.value)} /></Field><Field label={en.compare.to}><input type="date" min={from || undefined} value={to} onChange={(event) => setTo(event.target.value)} /></Field></div>
          <Button type="submit" className="full-button" disabled={selectedIds.length < 2 || comparing}>{comparing ? en.compare.comparing : en.compare.compareSelected}</Button>
          {selectedIds.length < 2 && <p className="field-hint centered">{en.compare.selectAtLeastTwo}</p>}
        </Card>

        <div className="comparison-output" aria-live="polite">
          {!result && !comparing && <Card><EmptyState title={en.compare.emptyTitle} description={en.compare.emptyDescription} /></Card>}
          {comparing && <Card><LoadingState label={en.compare.calculating} /></Card>}
          {result && !comparing && <ComparisonTable result={result} criteria={criteria} aggregation={aggregation} />}
        </div>
      </form>
    </div>
  );
}

function ComparisonTable({ result, criteria, aggregation }: { result: ComparisonResponse; criteria: Array<{ id: string; name: string }>; aggregation: Aggregation }) {
  if (result.entities.length === 0) return <Card><EmptyState title={en.compare.noReviews} description={en.compare.noReviewsDescription} /></Card>;
  if (aggregation === 'history') {
    return (
      <Card className="comparison-card history-comparison-card">
        <div className="section-heading"><div><p className="eyebrow">{en.compare.result}</p><h2>{en.compare.reviewHistory}</h2><p>{en.compare.historyDescription}</p></div></div>
        <div className="history-comparison-list">
          {result.entities.map((item) => (
            <section key={item.entityId}>
              <header><div><h3>{item.entityName || item.entity?.name || en.common.entity}</h3><small>{en.compare.reviewsLatest(item.reviewCount, formatDateTime(item.lastReviewedAt))}</small></div>{item.overallNormalizedValue != null && <Badge tone="info">{en.compare.overall(Math.round(item.overallNormalizedValue * 100))}</Badge>}</header>
              {!item.history?.length ? <p>{en.compare.noFinalReviews}</p> : (
                <ol>
                  {item.history.map((review) => (
                    <li key={review.id}>
                      <div><time dateTime={review.reviewedAt}>{formatDateTime(review.reviewedAt)}</time><small>{en.compare.templateVersion(review.templateVersion?.version ?? '?')}</small></div>
                      <div>{review.scores.map((score) => <span key={score.criterionId}><small>{score.criterionName || en.common.criterion}</small><strong>{formatScore(score.displayValue)}</strong><em>{score.normalizedValue == null ? '' : `${Math.round(score.normalizedValue * 100)}%`}</em></span>)}</div>
                    </li>
                  ))}
                </ol>
              )}
            </section>
          ))}
        </div>
      </Card>
    );
  }
  return (
    <Card className="comparison-card">
      <div className="section-heading"><div><p className="eyebrow">{en.compare.result}</p><h2>{aggregation === 'latest' ? en.compare.latestObservations : aggregation === 'mean' ? en.compare.meanScores : en.compare.reviewHistory}</h2><p>{en.compare.normalizedDescription}</p></div></div>
      <div className="comparison-table-wrap">
        <table className="comparison-table">
          <thead><tr><th scope="col">{en.common.entity}</th>{criteria.map((criterion) => <th scope="col" key={criterion.id}>{criterion.name}</th>)}<th scope="col">{en.compare.overallHeading}</th></tr></thead>
          <tbody>{result.entities.map((item) => <tr key={item.entityId}><th scope="row"><strong>{item.entityName || item.entity?.name || en.common.entity}</strong><small>{en.compare.reviewsLatest(item.reviewCount, formatDateTime(item.lastReviewedAt))}</small></th>{criteria.map((criterion) => {
            const projection = item.criteria.find((entry) => entry.criterionId === criterion.id);
            const normalized = projection?.normalizedValue;
            return <td key={criterion.id}>{!projection || projection.missing || normalized === null || normalized === undefined ? <span className="missing-value">{en.compare.missing}</span> : <div className="projection-cell"><strong>{formatScore(projection.displayValue)}</strong><span>{Math.round(normalized * 100)}%</span><i style={{ '--value': `${Math.max(0, Math.min(100, normalized * 100))}%` } as React.CSSProperties} /></div>}</td>;
          })}<td>{item.overallNormalizedValue === null || item.overallNormalizedValue === undefined ? '—' : <strong className="overall-score">{Math.round(item.overallNormalizedValue * 100)}<small>/100</small></strong>}</td></tr>)}</tbody>
        </table>
      </div>
      <div className="comparison-mobile-list">{result.entities.map((item) => <article key={item.entityId}><header><div><strong>{item.entityName || item.entity?.name || en.common.entity}</strong><small>{en.compare.reviewCount(item.reviewCount)}</small></div>{item.overallNormalizedValue !== null && item.overallNormalizedValue !== undefined && <span>{Math.round(item.overallNormalizedValue * 100)}</span>}</header>{criteria.map((criterion) => { const projection = item.criteria.find((entry) => entry.criterionId === criterion.id); return <div className="mobile-projection" key={criterion.id}><span>{criterion.name}</span>{!projection || projection.missing || projection.normalizedValue == null ? <em>{en.compare.missing}</em> : <><strong>{formatScore(projection.displayValue)}</strong><i><b style={{ width: `${projection.normalizedValue * 100}%` }} /></i><small>{Math.round(projection.normalizedValue * 100)}%</small></>}</div>; })}</article>)}</div>
    </Card>
  );
}
