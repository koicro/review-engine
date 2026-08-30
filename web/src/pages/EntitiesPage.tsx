import { useEffect, useId, useMemo, useRef, useState, type ChangeEvent, type FormEvent } from 'react';
import { useApi } from '../api/context';
import type { Category, Entity, Review, ReviewInput, ReviewPicture, TemplateVersion } from '../api/types';
import { ScoreInput } from '../components/ScoreInput';
import { Badge, Button, Card, Dialog, EmptyState, ErrorPanel, Field, LoadingState, Notice, PageHeader } from '../components/UI';
import { averageScore, criterionId, explainError, formatDateTime, formatScore, inputDateTimeToIso, tickDisplay, toLocalDateTimeInput } from '../lib';
import { en } from '../messages';

export const MAX_REVIEW_PICTURES = 3;
export const MAX_REVIEW_PICTURE_BYTES = 100_000_000;

const supportedPictureTypes = new Set(['image/jpeg', 'image/png', 'image/webp', 'image/gif']);
const supportedPictureExtension = /\.(?:jpe?g|png|webp|gif)$/i;

interface PendingPicture {
  id: string;
  file: File;
  previewUrl: string;
}

function formatFileSize(sizeBytes: number): string {
  if (sizeBytes < 1_000_000) return `${Math.max(1, Math.round(sizeBytes / 1_000))} KB`;
  const megabytes = sizeBytes / 1_000_000;
  return `${megabytes >= 10 ? Math.round(megabytes) : megabytes.toFixed(1)} MB`;
}

export function EntitiesPage() {
  const { api } = useApi();
  const [categories, setCategories] = useState<Category[]>([]);
  const [entities, setEntities] = useState<Entity[]>([]);
  const [selectedId, setSelectedId] = useState(() => window.sessionStorage.getItem('review-engine.selected-entity') || '');
  const [categoryFilter, setCategoryFilter] = useState('');
  const [queryInput, setQueryInput] = useState('');
  const [query, setQuery] = useState('');
  const [showArchived, setShowArchived] = useState(false);
  const [showHiddenReviews, setShowHiddenReviews] = useState(false);
  const [reviews, setReviews] = useState<Review[]>([]);
  const [reviewNextCursor, setReviewNextCursor] = useState<string | null | undefined>();
  const [template, setTemplate] = useState<TemplateVersion | null>(null);
  const [loading, setLoading] = useState(true);
  const [detailLoading, setDetailLoading] = useState(false);
  const [loadingMoreReviews, setLoadingMoreReviews] = useState(false);
  const [error, setError] = useState('');
  const [detailError, setDetailError] = useState('');
  const [notice, setNotice] = useState('');
  const [createOpen, setCreateOpen] = useState(false);
  const [reviewOpen, setReviewOpen] = useState(false);
  const [editingReview, setEditingReview] = useState<Review | null>(null);
  const [editingTemplate, setEditingTemplate] = useState<TemplateVersion | null>(null);
  const [visibilityChangingReviewId, setVisibilityChangingReviewId] = useState('');
  const [reviewRefreshKey, setReviewRefreshKey] = useState(0);
  const [refreshKey, setRefreshKey] = useState(0);
  const selectedIdRef = useRef(selectedId);
  const reviewRequestGenerationRef = useRef(0);
  selectedIdRef.current = selectedId;

  const selected = entities.find((entity) => entity.id === selectedId);
  const selectedCategory = categories.find((category) => category.id === selected?.categoryId);
  const hiddenHistoryMayExist = !showHiddenReviews && reviews.length === 0 && (selected?.reviewCount ?? 0) > 0;

  useEffect(() => {
    let active = true;
    setLoading(true);
    setError('');
    Promise.all([
      api.listAllCategories({ limit: 100 }),
      api.listAllEntities({ categoryId: categoryFilter || undefined, query: query || undefined, includeArchived: showArchived, limit: 100 }),
    ]).then(([allCategories, allEntities]) => {
      if (!active) return;
      setCategories(allCategories);
      setEntities(allEntities);
      setSelectedId((current) => allEntities.some((item) => item.id === current) ? current : allEntities[0]?.id || '');
    }).catch((cause) => active && setError(explainError(cause))).finally(() => active && setLoading(false));
    return () => { active = false; };
  }, [api, categoryFilter, query, showArchived, refreshKey]);

  useEffect(() => {
    if (!selected) {
      reviewRequestGenerationRef.current += 1;
      setReviews([]);
      setReviewNextCursor(null);
      setTemplate(null);
      return;
    }
    const requestGeneration = ++reviewRequestGenerationRef.current;
    window.sessionStorage.setItem('review-engine.selected-entity', selected.id);
    let active = true;
    setDetailLoading(true);
    setLoadingMoreReviews(false);
    setDetailError('');
    const category = categories.find((item) => item.id === selected.categoryId);
    const templatePromise = category?.activeTemplateVersion
      ? Promise.resolve(category.activeTemplateVersion)
      : category?.activeTemplateVersionId
        ? api.getTemplateVersion(category.activeTemplateVersionId)
        : Promise.resolve(null);
    Promise.all([
      api.listReviews(selected.id, { includeSuperseded: true, includeHidden: showHiddenReviews || undefined, limit: 50 }),
      templatePromise,
    ]).then(([reviewPage, activeTemplate]) => {
      if (!active || requestGeneration !== reviewRequestGenerationRef.current) return;
      setReviews(reviewPage.items);
      setReviewNextCursor(reviewPage.nextCursor);
      setTemplate(activeTemplate);
    }).catch((cause) => active && requestGeneration === reviewRequestGenerationRef.current && setDetailError(explainError(cause))).finally(() => {
      if (active && requestGeneration === reviewRequestGenerationRef.current) setDetailLoading(false);
    });
    return () => { active = false; };
  }, [api, selected, categories, showHiddenReviews, reviewRefreshKey, refreshKey]);

  async function loadMoreReviews() {
    if (!selected || !reviewNextCursor) return;
    const entityId = selected.id;
    const requestGeneration = reviewRequestGenerationRef.current;
    setLoadingMoreReviews(true);
    setDetailError('');
    try {
      const page = await api.listReviews(entityId, {
        includeSuperseded: true,
        includeHidden: showHiddenReviews || undefined,
        cursor: reviewNextCursor,
        limit: 50,
      });
      if (selectedIdRef.current !== entityId || requestGeneration !== reviewRequestGenerationRef.current) return;
      setReviews((items) => {
        const existing = new Set(items.map((item) => item.id));
        return [...items, ...page.items.filter((item) => !existing.has(item.id))];
      });
      setReviewNextCursor(page.nextCursor);
    } catch (cause) {
      if (selectedIdRef.current === entityId && requestGeneration === reviewRequestGenerationRef.current) setDetailError(explainError(cause));
    } finally {
      if (selectedIdRef.current === entityId && requestGeneration === reviewRequestGenerationRef.current) setLoadingMoreReviews(false);
    }
  }

  async function openReviewEditor(review: Review | null) {
    setDetailError('');
    setEditingReview(review);
    if (!review || review.templateVersionId === template?.id) {
      setEditingTemplate(template);
      setReviewOpen(true);
      return;
    }
    setDetailLoading(true);
    try {
      setEditingTemplate(await api.getTemplateVersion(review.templateVersionId));
      setReviewOpen(true);
    } catch (cause) {
      setDetailError(explainError(cause));
    } finally {
      setDetailLoading(false);
    }
  }

  async function updateReviewVisibility(review: Review, hidden: boolean) {
    if (hidden && !window.confirm(en.entities.hideReviewConfirmation)) return;
    setVisibilityChangingReviewId(review.id);
    setDetailError('');
    try {
      const updated = await api.updateReviewVisibility(review.id, { hidden, revision: review.revision });
      setReviews((items) => showHiddenReviews
        ? items.map((item) => item.id === updated.id ? updated : item)
        : items.filter((item) => item.id !== updated.id));
      reviewRequestGenerationRef.current += 1;
      setReviewNextCursor(undefined);
      setLoadingMoreReviews(false);
      setNotice(hidden ? en.entities.reviewHidden : en.entities.reviewRestored);
      setReviewRefreshKey((value) => value + 1);
    } catch (cause) {
      setDetailError(explainError(cause));
    } finally {
      setVisibilityChangingReviewId('');
    }
  }

  return (
    <div className="page-stack">
      <PageHeader
        eyebrow={en.entities.eyebrow}
        title={en.entities.title}
        description={en.entities.description}
        actions={<Button onClick={() => setCreateOpen(true)} disabled={categories.length === 0}>{en.entities.newEntity}</Button>}
      />
      {notice && <Notice tone="success">{notice}</Notice>}
      {error && <ErrorPanel message={error} onRetry={() => setRefreshKey((value) => value + 1)} />}
      <Card className="filter-bar">
        <form onSubmit={(event) => { event.preventDefault(); setQuery(queryInput.trim()); }} role="search">
          <label className="search-field"><span className="sr-only">{en.entities.searchEntities}</span><span aria-hidden="true">⌕</span><input value={queryInput} onChange={(event) => setQueryInput(event.target.value)} placeholder={en.entities.searchEntities} /><Button variant="secondary" type="submit">{en.common.actions.search}</Button></label>
          <label><span className="sr-only">{en.entities.filterCategory}</span><select value={categoryFilter} onChange={(event) => setCategoryFilter(event.target.value)}><option value="">{en.entities.allCategories}</option>{categories.map((category) => <option key={category.id} value={category.id}>{category.name}</option>)}</select></label>
          <label className="compact-check"><input type="checkbox" checked={showArchived} onChange={(event) => setShowArchived(event.target.checked)} /> {en.entities.showArchived}</label>
        </form>
      </Card>

      {loading ? <LoadingState label={en.entities.loading} /> : categories.length === 0 ? (
        <Card><EmptyState title={en.entities.setUpCategory} description={en.entities.setUpDescription} action={<a className="button button-primary" href="#/categories">{en.entities.goToCategories}</a>} /></Card>
      ) : (
        <div className="workspace-layout entities-layout">
          <Card className="workspace-sidebar entity-sidebar">
            <div className="sidebar-heading"><h2>{en.entities.entityCount(entities.length)}</h2></div>
            {entities.length === 0 ? <EmptyState title={en.entities.noMatches} description={en.entities.noMatchesDescription} action={<Button variant="secondary" onClick={() => setCreateOpen(true)}>{en.entities.addEntity}</Button>} /> : (
              <>
                <ul className="selection-list entity-selection-list">
                  {entities.map((entity) => (
                    <li key={entity.id}><button className={selectedId === entity.id ? 'selected' : ''} onClick={() => setSelectedId(entity.id)}><span className="entity-monogram" aria-hidden="true">{entity.name.slice(0, 1).toUpperCase()}</span><span><strong>{entity.name}</strong><small>{entity.category?.name || categories.find((item) => item.id === entity.categoryId)?.name}{entity.reviewCount !== undefined ? en.entities.reviewsCount(entity.reviewCount) : ''}</small></span>{entity.archivedAt && <Badge>{en.common.archived}</Badge>}</button></li>
                  ))}
                </ul>
              </>
            )}
          </Card>

          <div className="workspace-main">
            {!selected ? <Card><EmptyState title={en.entities.selectEntity} description={en.entities.selectDescription} /></Card> : (
              <>
                <EntitySummary entity={selected} category={selectedCategory} categories={categories} onChanged={(updated, message) => { setEntities((items) => items.map((item) => item.id === updated.id ? updated : item)); setNotice(message); }} onDeleted={() => { setEntities((items) => items.filter((item) => item.id !== selected.id)); setSelectedId(''); setNotice(en.entities.deleted(selected.name)); }} onError={setDetailError} />
                {detailError && <ErrorPanel message={detailError} onRetry={() => setRefreshKey((value) => value + 1)} />}
                {detailLoading ? <LoadingState label={en.entities.loadingHistory} /> : (
                  <Card>
                    <div className="section-heading timeline-heading">
                      <div><p className="eyebrow">{en.entities.timeline}</p><h2>{en.entities.reviewHistory}</h2><p>{en.entities.finalObservations(reviews.filter((review) => review.status === 'final').length, Boolean(reviewNextCursor))}</p></div>
                      <div className="timeline-actions"><label className="compact-check"><input type="checkbox" checked={showHiddenReviews} onChange={(event) => { reviewRequestGenerationRef.current += 1; setReviewNextCursor(undefined); setLoadingMoreReviews(false); setShowHiddenReviews(event.target.checked); }} /> {en.entities.showHiddenReviews}</label><Button onClick={() => void openReviewEditor(null)} disabled={!template || Boolean(selected.archivedAt)}>{template ? en.entities.recordReview : en.entities.publishTemplateFirst}</Button></div>
                    </div>
                    {reviews.length === 0 ? <EmptyState title={hiddenHistoryMayExist ? en.entities.noVisibleReviews : en.entities.noReviews} description={hiddenHistoryMayExist ? en.entities.noVisibleReviewsDescription : en.entities.noReviewsDescription} action={template && !selected.archivedAt && <Button variant="secondary" onClick={() => void openReviewEditor(null)}>{hiddenHistoryMayExist ? en.entities.recordReview : en.entities.recordFirstReview}</Button>} /> : (
                      <>
                        <ReviewTimeline reviews={reviews} activeTemplate={template} visibilityChangingReviewId={visibilityChangingReviewId} onEdit={(review) => void openReviewEditor(review)} onVisibilityChange={(review, hidden) => void updateReviewVisibility(review, hidden)} onDelete={async (review) => {
                          if (!window.confirm(en.entities.deleteDraftConfirmation)) return;
                          try { await api.deleteDraftReview(review.id, review.revision); setReviews((items) => items.filter((item) => item.id !== review.id)); setNotice(en.entities.draftDeleted); }
                          catch (cause) { setDetailError(explainError(cause)); }
                        }} />
                        {reviewNextCursor && <Button variant="quiet" className="load-more" onClick={() => void loadMoreReviews()} disabled={loadingMoreReviews}>{loadingMoreReviews ? en.entities.loadingOlder : en.entities.loadOlder}</Button>}
                      </>
                    )}
                  </Card>
                )}
              </>
            )}
          </div>
        </div>
      )}

      <CreateEntityDialog open={createOpen} categories={categories} initialCategoryId={categoryFilter} onClose={() => setCreateOpen(false)} onCreated={(entity) => {
        setEntities((items) => [entity, ...items]); setSelectedId(entity.id); setCreateOpen(false); setNotice(en.entities.added(entity.name));
      }} />

      {selected && editingTemplate && (
        <ReviewDialog
          open={reviewOpen}
          entity={selected}
          template={editingTemplate}
          review={editingReview}
          onClose={(changed) => { setReviewOpen(false); setEditingReview(null); setEditingTemplate(null); if (changed) setRefreshKey((value) => value + 1); }}
          onSaved={(review, finalized) => {
            setReviewOpen(false); setEditingReview(null); setEditingTemplate(null); setNotice(finalized ? en.entities.reviewAdded : en.entities.draftSaved); setRefreshKey((value) => value + 1);
          }}
        />
      )}
    </div>
  );
}

function CreateEntityDialog({ open, categories, initialCategoryId, onClose, onCreated }: { open: boolean; categories: Category[]; initialCategoryId: string; onClose: () => void; onCreated: (entity: Entity) => void }) {
  const { api } = useApi();
  const [categoryId, setCategoryId] = useState(initialCategoryId || categories[0]?.id || '');
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [error, setError] = useState('');
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (open) setCategoryId(initialCategoryId || categories[0]?.id || '');
  }, [open, initialCategoryId, categories]);

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (!name.trim() || !categoryId) return;
    setSaving(true); setError('');
    try {
      const entity = await api.createEntity({ categoryId, name: name.trim(), description: description.trim() || undefined });
      setName(''); setDescription(''); onCreated(entity);
    } catch (cause) { setError(explainError(cause)); }
    finally { setSaving(false); }
  }

  return (
    <Dialog open={open} onClose={onClose} title={en.entities.addTitle} description={en.entities.addDescription} size="small">
      <form className="form-stack" onSubmit={submit}>
        {error && <ErrorPanel message={error} />}
        <Field label={en.entities.category} required><select value={categoryId} onChange={(event) => setCategoryId(event.target.value)} required><option value="" disabled>{en.entities.selectCategory}</option>{categories.filter((item) => !item.archivedAt).map((category) => <option key={category.id} value={category.id}>{category.name}{!category.activeTemplateVersionId ? en.entities.templateNotPublished : ''}</option>)}</select></Field>
        <Field label={en.entities.name} required><input autoFocus value={name} onChange={(event) => setName(event.target.value)} placeholder={en.entities.namePlaceholder} /></Field>
        <Field label={en.entities.descriptionLabel}><textarea rows={4} value={description} onChange={(event) => setDescription(event.target.value)} placeholder={en.entities.descriptionPlaceholder} /></Field>
        <div className="form-actions"><Button type="button" variant="quiet" onClick={onClose}>{en.common.actions.cancel}</Button><Button type="submit" disabled={saving || !name.trim() || !categoryId}>{saving ? en.entities.adding : en.entities.addEntity}</Button></div>
      </form>
    </Dialog>
  );
}

function EntitySummary({ entity, category, categories, onChanged, onDeleted, onError }: { entity: Entity; category?: Category; categories: Category[]; onChanged: (entity: Entity, message: string) => void; onDeleted: () => void; onError: (message: string) => void }) {
  const { api } = useApi();
  const [editing, setEditing] = useState(false);
  const [name, setName] = useState(entity.name);
  const [description, setDescription] = useState(entity.description || '');
  const [categoryId, setCategoryId] = useState(entity.categoryId);
  const [saving, setSaving] = useState(false);
  useEffect(() => { setName(entity.name); setDescription(entity.description || ''); setCategoryId(entity.categoryId); }, [entity]);

  async function save(event: FormEvent) {
    event.preventDefault(); setSaving(true);
    try { const updated = await api.updateEntity(entity.id, { name: name.trim(), description: description.trim(), categoryId, revision: entity.revision }); onChanged(updated, en.entities.detailsSaved); setEditing(false); }
    catch (cause) { onError(explainError(cause)); } finally { setSaving(false); }
  }
  async function toggleArchive() {
    setSaving(true);
    try { const updated = await api.updateEntity(entity.id, { archived: !entity.archivedAt, revision: entity.revision }); onChanged(updated, entity.archivedAt ? en.entities.restored : en.entities.archived); }
    catch (cause) { onError(explainError(cause)); } finally { setSaving(false); }
  }
  async function remove() {
    if (!window.confirm(en.entities.deleteConfirmation(entity.name))) return;
    setSaving(true);
    try { await api.deleteEntity(entity.id); onDeleted(); }
    catch (cause) { onError(explainError(cause)); }
    finally { setSaving(false); }
  }

  return (
    <Card className="entity-summary-card">
      {editing ? <form className="form-stack" onSubmit={save}><h2>{en.entities.editTitle}</h2><div className="form-grid two-column"><Field label={en.entities.name} required><input value={name} onChange={(event) => setName(event.target.value)} /></Field><Field label={en.entities.category} hint={(entity.reviewCount ?? 0) > 0 ? en.entities.categoryLocked : en.entities.categoryChangeable}><select value={categoryId} onChange={(event) => setCategoryId(event.target.value)} disabled={(entity.reviewCount ?? 0) > 0}>{categories.filter((item) => !item.archivedAt).map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}</select></Field></div><Field label={en.entities.descriptionLabel}><textarea rows={3} value={description} onChange={(event) => setDescription(event.target.value)} /></Field><div className="form-actions"><Button type="button" variant="quiet" onClick={() => setEditing(false)}>{en.common.actions.cancel}</Button><Button type="submit" disabled={!name.trim() || saving}>{en.common.actions.save}</Button></div></form> : (
        <div className="entity-summary-content">
          <div className="entity-avatar" aria-hidden="true">{entity.name.slice(0, 2).toUpperCase()}</div>
          <div className="entity-summary-copy"><p className="eyebrow">{category?.name || entity.category?.name || en.common.entity}</p><div className="title-line"><h2>{entity.name}</h2>{entity.archivedAt && <Badge>{en.common.archived}</Badge>}</div><p>{entity.description || en.common.noDescription}</p><small>{en.entities.updated(formatDateTime(entity.updatedAt))}</small></div>
          <div className="inline-actions"><Button variant="quiet" onClick={() => setEditing(true)} disabled={Boolean(entity.archivedAt)}>{en.common.actions.edit}</Button><Button variant={entity.archivedAt ? 'secondary' : 'quiet'} onClick={toggleArchive} disabled={saving}>{entity.archivedAt ? en.common.actions.restore : en.common.actions.archive}</Button>{entity.archivedAt && <Button variant="danger" onClick={remove} disabled={saving}>{en.common.actions.delete}</Button>}</div>
        </div>
      )}
    </Card>
  );
}

function ReviewTimeline({ reviews, activeTemplate, visibilityChangingReviewId, onEdit, onDelete, onVisibilityChange }: { reviews: Review[]; activeTemplate: TemplateVersion | null; visibilityChangingReviewId: string; onEdit: (review: Review) => void; onDelete: (review: Review) => void; onVisibilityChange: (review: Review, hidden: boolean) => void }) {
  return (
    <ol className="review-timeline">
      {reviews.map((review) => {
        const definition = review.templateVersionId === activeTemplate?.id ? activeTemplate : null;
        const hidden = Boolean(review.hiddenAt);
        const className = [review.status === 'superseded' ? 'superseded' : '', hidden ? 'hidden-review' : ''].filter(Boolean).join(' ');
        const scoreValues = review.scores.map((score) => {
          const criterion = definition?.criteria.find((item) => criterionId(item) === score.criterionId);
          return score.displayValue ?? (criterion ? tickDisplay(criterion, score.tickIndex) : null);
        });
        const average = averageScore(scoreValues);
        return (
          <li key={review.id} className={className}>
            <div className="timeline-dot" aria-hidden="true" />
            <article>
              <header><div><time dateTime={review.reviewedAt}>{formatDateTime(review.reviewedAt)}</time><span>{en.entities.templateVersion(review.templateVersion?.version ?? definition?.version ?? '?')}</span>{review.reviewer?.displayName && <span>{en.entities.reviewedBy(review.reviewer.displayName)}</span>}</div><div className="review-badges">{hidden && <Badge>{en.entities.hiddenReview}</Badge>}<Badge tone={review.status === 'final' ? 'success' : review.status === 'draft' ? 'warning' : 'neutral'}>{en.common.status(review.status)}</Badge></div></header>
              <div className="review-scores">
                {average !== null && <div className="review-average"><span>{en.entities.averageScore}</span><strong>{formatScore(average)}</strong></div>}
                {review.scores.map((score) => {
                  const criterion = definition?.criteria.find((item) => criterionId(item) === score.criterionId);
                  const displayValue = score.displayValue ?? (criterion ? tickDisplay(criterion, score.tickIndex) : score.tickIndex);
                  return <div key={score.criterionId}><span>{score.criterionName || criterion?.name || en.common.criterion}</span><strong>{formatScore(displayValue)}</strong>{score.normalizedValue !== undefined && <small>{Math.round(score.normalizedValue * 100)}%</small>}</div>;
                })}
              </div>
              {review.properties?.length ? <div className="review-property-values">{review.properties.map((property) => <div key={property.propertyId}><span>{property.propertyName}</span><strong>{property.type === 'checkbox' ? (property.value ? 'Yes' : 'No') : String(property.value)}</strong></div>)}</div> : null}
              {review.pictures?.length > 0 && <ReviewPictureGallery pictures={review.pictures} />}
              <footer>{review.status === 'draft' ? <><button className="text-button danger-text" onClick={() => onDelete(review)}>{en.entities.deleteDraft}</button><button className="text-button" onClick={() => onEdit(review)}>{en.entities.continueDraft}</button></> : <><button className={hidden ? 'text-button' : 'text-button danger-text'} disabled={visibilityChangingReviewId === review.id} onClick={() => onVisibilityChange(review, !hidden)}>{hidden ? en.entities.restoreReview : en.entities.hideReview}</button>{review.status === 'final' && !hidden && <button className="text-button" onClick={() => onEdit(review)}>{en.entities.correctReview}</button>}</>}</footer>
            </article>
          </li>
        );
      })}
    </ol>
  );
}

function ReviewPictureGallery({ pictures }: { pictures: ReviewPicture[] }) {
  const { api } = useApi();
  return (
    <ul className="review-picture-grid" aria-label={en.entities.pictures}>
      {pictures.map((picture) => {
        const pictureUrl = api.resolveResourceUrl(picture.url);
        return (
          <li key={picture.id}>
            {pictureUrl ? (
              <a href={pictureUrl} target="_blank" rel="noreferrer" aria-label={en.entities.openPicture(picture.fileName)}>
                <img src={pictureUrl} alt={picture.fileName} loading="lazy" decoding="async" />
                <span><strong>{picture.fileName}</strong><small>{formatFileSize(picture.sizeBytes)}</small></span>
              </a>
            ) : <span><strong>{picture.fileName}</strong><small>{formatFileSize(picture.sizeBytes)}</small></span>}
          </li>
        );
      })}
    </ul>
  );
}

function ReviewDialog({ open, entity, template, review, onClose, onSaved }: { open: boolean; entity: Entity; template: TemplateVersion; review: Review | null; onClose: (changed: boolean) => void; onSaved: (review: Review, finalized: boolean) => void }) {
  const { api } = useApi();
  const pictureInputId = useId();
  const [reviewedAt, setReviewedAt] = useState(toLocalDateTimeInput());
  const [scores, setScores] = useState<Record<string, number | undefined>>({});
  const [propertyValues, setPropertyValues] = useState<Record<string, string | boolean | undefined>>({});
  const [workingReview, setWorkingReview] = useState<Review | null>(review);
  const [selectedPictures, setSelectedPictures] = useState<PendingPicture[]>([]);
  const [removedPictureIds, setRemovedPictureIds] = useState<Set<string>>(new Set());
  const [pictureError, setPictureError] = useState('');
  const [saving, setSaving] = useState<'draft' | 'final' | ''>('');
  const [error, setError] = useState('');
  const previewUrlsRef = useRef(new Set<string>());
  const pictureSequenceRef = useRef(0);
  const isCorrection = review?.status === 'final';
  const isDraft = review?.status === 'draft';

  useEffect(() => {
    if (!open) return;
    previewUrlsRef.current.forEach((url) => URL.revokeObjectURL?.(url));
    previewUrlsRef.current.clear();
    setReviewedAt(review ? toLocalDateTimeInput(new Date(review.reviewedAt)) : toLocalDateTimeInput());
    setScores(Object.fromEntries((review?.scores || []).map((score) => [score.criterionId, score.tickIndex])));
    setPropertyValues(Object.fromEntries((review?.properties || []).map((property) => [property.propertyId, property.value])));
    setWorkingReview(review);
    setSelectedPictures([]);
    setRemovedPictureIds(new Set());
    setPictureError('');
    setError('');
  }, [open, review]);

  useEffect(() => () => {
    previewUrlsRef.current.forEach((url) => URL.revokeObjectURL?.(url));
    previewUrlsRef.current.clear();
  }, []);

  const missingRequired = template.criteria.filter((criterion) => criterion.required && scores[criterionId(criterion)] === undefined);
  const missingRequiredProperties = (template.properties || []).filter((property) => property.required && (propertyValues[property.id] === undefined || (typeof propertyValues[property.id] === 'string' && !String(propertyValues[property.id]).trim())));
  const persistedPictures = workingReview?.pictures ?? review?.pictures ?? [];
  const visiblePersistedPictures = persistedPictures.filter((picture) => !removedPictureIds.has(picture.id));
  const pictureCount = visiblePersistedPictures.length + selectedPictures.length;
  const persistedDuringDialog = Boolean(workingReview && (!review || workingReview.revision !== review.revision));
  const payload = (): ReviewInput => ({
    reviewedAt: inputDateTimeToIso(reviewedAt),
    scores: template.criteria.flatMap((criterion) => {
      const id = criterionId(criterion);
      const tickIndex = scores[id];
      return tickIndex === undefined ? [] : [{ criterionId: id, tickIndex }];
    }),
    properties: (template.properties || []).flatMap((property) => {
      const value = propertyValues[property.id];
      return value === undefined ? [] : [{ propertyId: property.id, value }];
    }),
  });

  function selectPictures(event: ChangeEvent<HTMLInputElement>) {
    const files = Array.from(event.currentTarget.files ?? []);
    event.currentTarget.value = '';
    let remaining = MAX_REVIEW_PICTURES - pictureCount;
    let validationError = '';
    const additions: PendingPicture[] = [];

    for (const file of files) {
      if (file.size === 0) {
        validationError ||= en.entities.pictureEmpty(file.name);
        continue;
      }
      const reportedType = file.type.toLowerCase();
      if (!supportedPictureTypes.has(reportedType) && (reportedType !== '' || !supportedPictureExtension.test(file.name))) {
        validationError ||= en.entities.pictureTypeInvalid(file.name);
        continue;
      }
      if (file.size > MAX_REVIEW_PICTURE_BYTES) {
        validationError ||= en.entities.pictureTooLarge(file.name);
        continue;
      }
      if (remaining <= 0) {
        validationError ||= en.entities.pictureLimitReached;
        continue;
      }
      const previewUrl = typeof URL.createObjectURL === 'function' ? URL.createObjectURL(file) : '';
      if (previewUrl) previewUrlsRef.current.add(previewUrl);
      additions.push({ id: `pending-picture-${++pictureSequenceRef.current}`, file, previewUrl });
      remaining -= 1;
    }

    if (additions.length) setSelectedPictures((current) => [...current, ...additions]);
    setPictureError(validationError);
  }

  function removeSelectedPicture(picture: PendingPicture) {
    if (picture.previewUrl) {
      URL.revokeObjectURL?.(picture.previewUrl);
      previewUrlsRef.current.delete(picture.previewUrl);
    }
    setSelectedPictures((current) => current.filter((item) => item.id !== picture.id));
    setPictureError('');
  }

  function clearUploadedPictures(uploaded: PendingPicture[]) {
    const uploadedIds = new Set(uploaded.map((picture) => picture.id));
    uploaded.forEach((picture) => {
      if (picture.previewUrl) {
        URL.revokeObjectURL?.(picture.previewUrl);
        previewUrlsRef.current.delete(picture.previewUrl);
      }
    });
    setSelectedPictures((current) => current.filter((picture) => !uploadedIds.has(picture.id)));
  }

  function closeDialog() {
    if (!saving) onClose(persistedDuringDialog);
  }

  async function submit(mode: 'draft' | 'final') {
    if (mode === 'final' && (missingRequired.length || missingRequiredProperties.length)) {
      setError(en.entities.requiredScores([...missingRequired.map((item) => item.name), ...missingRequiredProperties.map((item) => item.name)].join(', ')));
      return;
    }
    setSaving(mode); setError('');
    try {
      const input = payload();
      if (isCorrection && review) {
        const saved = await api.reviseReview(review.id, { ...input, revision: review.revision });
        onSaved(saved, true);
        return;
      }

      const hasPictureChanges = selectedPictures.length > 0 || removedPictureIds.size > 0;
      let current = workingReview;
      if (!hasPictureChanges) {
        const saved = current
          ? await api.updateReview(current.id, { ...input, revision: current.revision, finalize: mode === 'final' })
          : await api.createReview(entity.id, { ...input, finalize: mode === 'final' });
        onSaved(saved, mode === 'final');
        return;
      }

      current = current
        ? await api.updateReview(current.id, { ...input, revision: current.revision, finalize: false })
        : await api.createReview(entity.id, { ...input, finalize: false });
      setWorkingReview(current);

      for (const pictureId of removedPictureIds) {
        current = await api.deleteReviewPicture(current.id, pictureId, current.revision);
        setWorkingReview(current);
        setRemovedPictureIds((ids) => {
          const next = new Set(ids);
          next.delete(pictureId);
          return next;
        });
      }

      if (selectedPictures.length) {
        const uploaded = selectedPictures;
        current = await api.uploadReviewPictures(current.id, uploaded.map((picture) => picture.file), current.revision);
        setWorkingReview(current);
        clearUploadedPictures(uploaded);
      }

      if (mode === 'final') {
        current = await api.finalizeReview(current.id, { scores: input.scores, properties: input.properties, revision: current.revision });
      }
      onSaved(current, mode === 'final');
    } catch (cause) { setError(explainError(cause)); }
    finally { setSaving(''); }
  }

  return (
    <Dialog open={open} onClose={closeDialog} closeDisabled={Boolean(saving)} title={isCorrection ? en.entities.correctTitle(entity.name) : isDraft ? en.entities.continueTitle(entity.name) : en.entities.reviewTitle(entity.name)} description={isCorrection ? en.entities.correctionDescription : en.entities.usingTemplate(template.version)} size="large">
      <form className="review-form" aria-busy={Boolean(saving)} onSubmit={(event) => { event.preventDefault(); void submit('final'); }}>
        {error && <ErrorPanel message={error} />}
        <div className="review-form-top"><Field label={en.entities.observedAt} required><input type="datetime-local" value={reviewedAt} max="9999-12-31T23:59" onChange={(event) => setReviewedAt(event.target.value)} disabled={Boolean(saving)} required /></Field><div className="review-progress"><span>{template.criteria.length - missingRequired.length} / {template.criteria.length}</span><small>{en.entities.criteriaReady}</small></div></div>
        <div className="score-inputs">
          {[...template.criteria].sort((a, b) => a.position - b.position).map((criterion) => <ScoreInput key={criterionId(criterion)} criterion={criterion} value={scores[criterionId(criterion)]} onChange={(value) => setScores((items) => ({ ...items, [criterionId(criterion)]: value }))} disabled={Boolean(saving)} />)}
        </div>
        {(template.properties || []).length > 0 && <div className="review-properties">
          {(template.properties || []).sort((a, b) => a.position - b.position).map((property) => <Field key={property.id} label={property.name} required={property.required} hint={property.description || undefined}>
            {property.type === 'select' ? <select value={typeof propertyValues[property.id] === 'string' ? propertyValues[property.id] as string : ''} onChange={(event) => setPropertyValues((items) => ({ ...items, [property.id]: event.target.value }))} disabled={Boolean(saving)}><option value="">{en.entities.selectPropertyValue}</option>{property.options.map((option) => <option key={option} value={option}>{option}</option>)}</select> : property.type === 'checkbox' ? <input type="checkbox" checked={propertyValues[property.id] === true} onChange={(event) => setPropertyValues((items) => ({ ...items, [property.id]: event.target.checked }))} disabled={Boolean(saving)} /> : <input value={typeof propertyValues[property.id] === 'string' ? propertyValues[property.id] as string : ''} onChange={(event) => setPropertyValues((items) => ({ ...items, [property.id]: event.target.value }))} disabled={Boolean(saving)} />}
          </Field>)}
        </div>}
        {isCorrection ? persistedPictures.length > 0 && (
          <section className="review-picture-editor" aria-labelledby={`${pictureInputId}-heading`}>
            <div className="picture-editor-heading"><div><h3 id={`${pictureInputId}-heading`}>{en.entities.pictures}</h3><p>{en.entities.picturesInherited}</p></div><span>{en.entities.pictureCount(persistedPictures.length)}</span></div>
            <ReviewPictureGallery pictures={persistedPictures} />
          </section>
        ) : (
          <section className="review-picture-editor" aria-labelledby={`${pictureInputId}-heading`}>
            <div className="picture-editor-heading"><div><h3 id={`${pictureInputId}-heading`}>{en.entities.pictures}</h3><p id={`${pictureInputId}-hint`}>{en.entities.picturesHint}</p></div><span aria-live="polite">{en.entities.pictureCount(pictureCount)}</span></div>
            {(visiblePersistedPictures.length > 0 || selectedPictures.length > 0) && (
              <ul className="review-picture-grid editable-picture-grid">
                {visiblePersistedPictures.map((picture) => {
                  const pictureUrl = api.resolveResourceUrl(picture.url);
                  return (
                    <li key={picture.id}>
                      {pictureUrl ? <a href={pictureUrl} target="_blank" rel="noreferrer" aria-label={en.entities.openPicture(picture.fileName)}><img src={pictureUrl} alt={picture.fileName} loading="lazy" decoding="async" /></a> : <span className="picture-placeholder" aria-hidden="true">IMG</span>}
                      <span><strong>{picture.fileName}</strong><small>{formatFileSize(picture.sizeBytes)}</small></span>
                      <button type="button" className="icon-button danger" aria-label={en.entities.removePicture(picture.fileName)} disabled={Boolean(saving)} onClick={() => { setRemovedPictureIds((ids) => new Set(ids).add(picture.id)); setPictureError(''); }}>×</button>
                    </li>
                  );
                })}
                {selectedPictures.map((picture) => (
                  <li key={picture.id}>
                    {picture.previewUrl ? <img src={picture.previewUrl} alt={picture.file.name} decoding="async" /> : <span className="picture-placeholder" aria-hidden="true">IMG</span>}
                    <span><strong>{picture.file.name}</strong><small>{formatFileSize(picture.file.size)}</small></span>
                    <button type="button" className="icon-button danger" aria-label={en.entities.removePicture(picture.file.name)} disabled={Boolean(saving)} onClick={() => removeSelectedPicture(picture)}>×</button>
                  </li>
                ))}
              </ul>
            )}
            <div className="picture-picker-row">
              <label className={`button button-secondary picture-picker ${pictureCount >= MAX_REVIEW_PICTURES || saving ? 'disabled' : ''}`} htmlFor={pictureInputId}>
                {en.entities.choosePictures}
              </label>
              <input id={pictureInputId} className="sr-only" type="file" accept=".jpg,.jpeg,.png,.webp,.gif,image/jpeg,image/png,image/webp,image/gif" multiple aria-describedby={`${pictureInputId}-hint`} disabled={pictureCount >= MAX_REVIEW_PICTURES || Boolean(saving)} onChange={selectPictures} />
            </div>
            {pictureError && <p className="picture-error" role="alert">{pictureError}</p>}
          </section>
        )}
        <div className="form-actions sticky-actions"><Button type="button" variant="quiet" onClick={closeDialog} disabled={Boolean(saving)}>{en.common.actions.cancel}</Button>{!isCorrection && <Button type="button" variant="secondary" onClick={() => void submit('draft')} disabled={Boolean(saving)}>{saving === 'draft' ? en.categories.saving : en.categories.saveDraft}</Button>}<Button type="submit" disabled={Boolean(saving) || !reviewedAt}>{saving === 'final' ? en.categories.saving : isCorrection ? en.entities.saveCorrection : en.entities.finalizeReview}</Button></div>
      </form>
    </Dialog>
  );
}
