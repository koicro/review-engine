import { useEffect, useMemo, useState, type FormEvent } from 'react';
import { useApi } from '../api/context';
import type { Category, Criterion, PropertyDefinition, PropertyType, TemplateVersion } from '../api/types';
import { Badge, Button, Card, Dialog, EmptyState, ErrorPanel, Field, LoadingState, Notice, PageHeader } from '../components/UI';
import { criterionId, explainError, formatDateTime } from '../lib';
import { en } from '../messages';

function freshCriterion(position: number): Criterion {
  const id = typeof crypto.randomUUID === 'function'
    ? crypto.randomUUID()
    : `criterion-${Date.now()}-${position}`;
  return {
    id,
    criterionId: id,
    name: '',
    description: '',
    minValue: 0,
    maxValue: 5,
    stepValue: 1,
    position,
    required: true,
  };
}

function validateCriteria(criteria: Criterion[]): string[] {
  const errors: string[] = [];
  if (criteria.length === 0) errors.push(en.categories.addCriterion);
  criteria.forEach((criterion, index) => {
    const min = Number(criterion.minValue);
    const max = Number(criterion.maxValue);
    const step = Number(criterion.stepValue);
    const name = criterion.name || en.categories.criterionFallback(index + 1);
    if (!criterion.name.trim()) errors.push(en.categories.criterionName(index + 1));
    if (![min, max, step].every(Number.isFinite)) errors.push(en.categories.numericScale(name));
    else if (min >= max) errors.push(en.categories.maxGreater(name));
    else if (step <= 0) errors.push(en.categories.stepPositive(name));
    else if (Math.abs((max - min) / step - Math.round((max - min) / step)) > 1e-9) errors.push(en.categories.rangeDivisible(name));
  });
  return errors;
}

function freshProperty(position: number): PropertyDefinition {
  const id = typeof crypto.randomUUID === 'function' ? crypto.randomUUID() : `property-${Date.now()}-${position}`;
  return { id, name: '', type: 'text', options: [], position, required: false };
}

function validateProperties(properties: PropertyDefinition[]): string[] {
  const errors: string[] = [];
  const names = new Set<string>();
  properties.forEach((property, index) => {
    if (!property.name.trim()) errors.push(`Property ${index + 1} needs a name.`);
    const key = property.name.trim().toLowerCase();
    if (key && names.has(key)) errors.push(`Property ${index + 1} has a duplicate name.`);
    if (key) names.add(key);
    if (property.type === 'select' && property.options.length === 0) errors.push(`${property.name || `Property ${index + 1}`} needs at least one option.`);
  });
  return errors;
}

export function CategoriesPage() {
  const { api } = useApi();
  const [categories, setCategories] = useState<Category[]>([]);
  const [selectedId, setSelectedId] = useState('');
  const [versions, setVersions] = useState<TemplateVersion[]>([]);
  const [selectedVersionId, setSelectedVersionId] = useState('');
  const [loading, setLoading] = useState(true);
  const [versionsLoading, setVersionsLoading] = useState(false);
  const [error, setError] = useState('');
  const [actionError, setActionError] = useState('');
  const [notice, setNotice] = useState('');
  const [createOpen, setCreateOpen] = useState(false);
  const [showArchived, setShowArchived] = useState(false);
  const [refreshKey, setRefreshKey] = useState(0);

  const selected = categories.find((category) => category.id === selectedId);
  const selectedVersion = versions.find((version) => version.id === selectedVersionId)
    || versions.find((version) => version.status === 'draft')
    || versions.find((version) => version.id === selected?.activeTemplateVersionId)
    || versions[0];

  useEffect(() => {
    let active = true;
    setLoading(true);
    setError('');
    api.listAllCategories({ includeArchived: showArchived, limit: 100 }).then((items) => {
      if (!active) return;
      setCategories(items);
      setSelectedId((current) => items.some((item) => item.id === current) ? current : items[0]?.id || '');
    }).catch((cause) => active && setError(explainError(cause))).finally(() => active && setLoading(false));
    return () => { active = false; };
  }, [api, showArchived, refreshKey]);

  useEffect(() => {
    if (!selectedId) {
      setVersions([]);
      return;
    }
    let active = true;
    setVersionsLoading(true);
    setActionError('');
    api.listTemplateVersions(selectedId).then((page) => {
      if (!active) return;
      const ordered = [...page.items].sort((a, b) => b.version - a.version);
      setVersions(ordered);
      setSelectedVersionId((current) => ordered.some((item) => item.id === current) ? current : ordered.find((item) => item.status === 'draft')?.id || ordered[0]?.id || '');
    }).catch((cause) => active && setActionError(explainError(cause))).finally(() => active && setVersionsLoading(false));
    return () => { active = false; };
  }, [api, selectedId, refreshKey]);

  async function createDraft() {
    if (!selected) return;
    setActionError('');
    try {
      const draft = await api.createTemplateDraft(selected.id);
      setVersions((items) => [draft, ...items]);
      setSelectedVersionId(draft.id);
      setNotice(en.categories.draftCreated(draft.version));
    } catch (cause) {
      setActionError(explainError(cause));
    }
  }

  return (
    <div className="page-stack">
      <PageHeader
        eyebrow={en.categories.eyebrow}
        title={en.categories.title}
        description={en.categories.description}
        actions={<Button onClick={() => setCreateOpen(true)}>{en.categories.newCategory}</Button>}
      />
      {notice && <Notice tone="success">{notice}</Notice>}
      {error && <ErrorPanel message={error} onRetry={() => setRefreshKey((value) => value + 1)} />}
      {loading ? <LoadingState label={en.categories.loading} /> : (
        <div className="workspace-layout">
          <Card className="workspace-sidebar">
            <div className="sidebar-heading">
              <h2>{en.categories.categories}</h2>
              <label className="compact-check"><input type="checkbox" checked={showArchived} onChange={(event) => setShowArchived(event.target.checked)} /> {en.categories.showArchived}</label>
            </div>
            {categories.length === 0 ? (
              <EmptyState title={en.categories.noCategories} description={en.categories.noCategoriesDescription} action={<Button variant="secondary" onClick={() => setCreateOpen(true)}>{en.categories.createCategory}</Button>} />
            ) : (
              <ul className="selection-list">
                {categories.map((category) => (
                  <li key={category.id}>
                    <button className={selectedId === category.id ? 'selected' : ''} onClick={() => setSelectedId(category.id)}>
                      <span><strong>{category.name}</strong><small>{category.activeTemplateVersionId ? en.categories.templatePublished : en.categories.needsTemplate}</small></span>
                      {category.archivedAt && <Badge>{en.common.archived}</Badge>}
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </Card>

          <div className="workspace-main">
            {!selected ? (
              <Card><EmptyState title={en.categories.selectCategory} description={en.categories.selectDescription} /></Card>
            ) : (
              <>
                <CategoryDetails
                  category={selected}
                  onSaved={(category, message) => {
                    setCategories((items) => items.map((item) => item.id === category.id ? category : item));
                    setNotice(message);
                  }}
                  onError={setActionError}
                  onDeleted={() => {
                    setCategories((items) => items.filter((item) => item.id !== selected.id));
                    setSelectedId('');
                    setNotice(en.categories.deleted(selected.name));
                  }}
                />
                <Card>
                  <div className="section-heading">
                    <div><p className="eyebrow">{en.categories.scorecard}</p><h2>{en.categories.templateVersions}</h2></div>
                    {!versions.some((version) => version.status === 'draft') && !selected.archivedAt && <Button variant="secondary" onClick={createDraft}>{versions.length ? en.categories.createNewVersion : en.categories.createTemplate}</Button>}
                  </div>
                  {actionError && <ErrorPanel message={actionError} />}
                  {versionsLoading ? <LoadingState label={en.categories.loadingVersions} /> : versions.length === 0 ? (
                    <EmptyState title={en.categories.noTemplate} description={en.categories.noTemplateDescription} action={!selected.archivedAt && <Button onClick={createDraft}>{en.categories.createTemplate}</Button>} />
                  ) : (
                    <>
                      <div className="version-tabs" role="tablist" aria-label={en.categories.versionTabs}>
                        {versions.map((version) => (
                          <button key={version.id} role="tab" aria-selected={selectedVersion?.id === version.id} className={selectedVersion?.id === version.id ? 'active' : ''} onClick={() => setSelectedVersionId(version.id)}>
                            {en.categories.versionTab(version.version)} <Badge tone={version.status === 'published' ? 'success' : version.status === 'draft' ? 'warning' : 'neutral'}>{en.common.status(version.status)}</Badge>
                          </button>
                        ))}
                      </div>
                      {selectedVersion && (
                        selectedVersion.status === 'draft' ? (
                          <CriterionEditor
                            key={`${selectedVersion.id}-${selectedVersion.revision ?? 0}`}
                            version={selectedVersion}
                            onSaved={(version) => {
                              setVersions((items) => items.map((item) => item.id === version.id ? version : item));
                              setNotice(en.categories.draftSaved);
                            }}
                            onPublished={(version) => {
                              setVersions((items) => items.map((item) => item.id === version.id ? version : item.id === selected.activeTemplateVersionId ? { ...item, status: 'retired' } : item));
                              setCategories((items) => items.map((item) => item.id === selected.id ? { ...item, activeTemplateVersionId: version.id } : item));
                              setNotice(en.categories.published(version.version));
                            }}
                            onError={setActionError}
                          />
                        ) : <PublishedTemplate version={selectedVersion} />
                      )}
                    </>
                  )}
                </Card>
              </>
            )}
          </div>
        </div>
      )}
      <CreateCategoryDialog open={createOpen} onClose={() => setCreateOpen(false)} onCreated={(category) => {
        setCategories((items) => [category, ...items]);
        setSelectedId(category.id);
        setCreateOpen(false);
        setNotice(en.categories.created(category.name));
      }} />
    </div>
  );
}

function CreateCategoryDialog({ open, onClose, onCreated }: { open: boolean; onClose: () => void; onCreated: (category: Category) => void }) {
  const { api } = useApi();
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [error, setError] = useState('');
  const [saving, setSaving] = useState(false);

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (!name.trim()) return setError(en.categories.enterName);
    setSaving(true);
    setError('');
    try {
      const category = await api.createCategory({ name: name.trim(), description: description.trim() || undefined });
      setName('');
      setDescription('');
      onCreated(category);
    } catch (cause) { setError(explainError(cause)); }
    finally { setSaving(false); }
  }

  return (
    <Dialog open={open} onClose={onClose} title={en.categories.createTitle} description={en.categories.createDescription} size="small">
      <form className="form-stack" onSubmit={submit}>
        {error && <ErrorPanel message={error} />}
        <Field label={en.categories.name} required><input autoFocus value={name} onChange={(event) => setName(event.target.value)} placeholder={en.categories.namePlaceholder} /></Field>
        <Field label={en.categories.descriptionLabel} hint={en.categories.descriptionHint}><textarea value={description} onChange={(event) => setDescription(event.target.value)} rows={4} /></Field>
        <div className="form-actions"><Button type="button" variant="quiet" onClick={onClose}>{en.common.actions.cancel}</Button><Button type="submit" disabled={saving}>{saving ? en.categories.creating : en.categories.createCategory}</Button></div>
      </form>
    </Dialog>
  );
}

function CategoryDetails({ category, onSaved, onError, onDeleted }: { category: Category; onSaved: (category: Category, message: string) => void; onError: (message: string) => void; onDeleted: () => void }) {
  const { api } = useApi();
  const [editing, setEditing] = useState(false);
  const [name, setName] = useState(category.name);
  const [description, setDescription] = useState(category.description || '');
  const [saving, setSaving] = useState(false);

  useEffect(() => { setName(category.name); setDescription(category.description || ''); }, [category]);

  async function save(event: FormEvent) {
    event.preventDefault();
    setSaving(true);
    try {
      const updated = await api.updateCategory(category.id, { name: name.trim(), description: description.trim(), revision: category.revision });
      onSaved(updated, en.categories.detailsSaved);
      setEditing(false);
    } catch (cause) { onError(explainError(cause)); }
    finally { setSaving(false); }
  }

  async function toggleArchived() {
    setSaving(true);
    try {
      const updated = await api.updateCategory(category.id, { archived: !category.archivedAt, revision: category.revision });
      onSaved(updated, category.archivedAt ? en.categories.restored : en.categories.archived);
    } catch (cause) { onError(explainError(cause)); }
    finally { setSaving(false); }
  }

  async function remove() {
    if (!window.confirm(en.categories.deleteConfirmation(category.name))) return;
    setSaving(true);
    try { await api.deleteCategory(category.id); onDeleted(); }
    catch (cause) { onError(explainError(cause)); }
    finally { setSaving(false); }
  }

  return (
    <Card>
      {editing ? (
        <form className="form-stack" onSubmit={save}>
          <div className="section-heading"><h2>{en.categories.edit}</h2></div>
          <Field label={en.categories.name} required><input value={name} onChange={(event) => setName(event.target.value)} required /></Field>
          <Field label={en.categories.descriptionLabel}><textarea rows={3} value={description} onChange={(event) => setDescription(event.target.value)} /></Field>
          <div className="form-actions"><Button type="button" variant="quiet" onClick={() => setEditing(false)}>{en.common.actions.cancel}</Button><Button type="submit" disabled={saving || !name.trim()}>{en.categories.saveChanges}</Button></div>
        </form>
      ) : (
        <div className="category-summary">
          <div><div className="title-line"><h2>{category.name}</h2>{category.archivedAt && <Badge>{en.common.archived}</Badge>}</div><p>{category.description || en.common.noDescription}</p></div>
          <div className="inline-actions"><Button variant="quiet" onClick={() => setEditing(true)} disabled={Boolean(category.archivedAt)}>{en.common.actions.edit}</Button><Button variant={category.archivedAt ? 'secondary' : 'quiet'} onClick={toggleArchived} disabled={saving}>{category.archivedAt ? en.common.actions.restore : en.common.actions.archive}</Button>{category.archivedAt && <Button variant="danger" onClick={remove} disabled={saving}>{en.common.actions.delete}</Button>}</div>
        </div>
      )}
    </Card>
  );
}

function CriterionEditor({ version, onSaved, onPublished, onError }: { version: TemplateVersion; onSaved: (version: TemplateVersion) => void; onPublished: (version: TemplateVersion) => void; onError: (message: string) => void }) {
  const { api } = useApi();
  const [criteria, setCriteria] = useState(version.criteria.length ? version.criteria : [freshCriterion(0)]);
  const [properties, setProperties] = useState<PropertyDefinition[]>(version.properties || []);
  const [propertyOptionDrafts, setPropertyOptionDrafts] = useState<Record<string, string>>(() => Object.fromEntries((version.properties || []).map((property) => [property.id, property.options.join(', ')])));
  const [saving, setSaving] = useState(false);
  const [publishing, setPublishing] = useState(false);
  const validation = useMemo(() => [...validateCriteria(criteria), ...validateProperties(properties)], [criteria, properties]);

  function update(id: string, patch: Partial<Criterion>) {
    setCriteria((items) => items.map((item) => criterionId(item) === id ? { ...item, ...patch } : item));
  }

  function move(index: number, offset: number) {
    setCriteria((items) => {
      const next = [...items];
      const destination = index + offset;
      if (destination < 0 || destination >= next.length) return items;
      const [item] = next.splice(index, 1);
      next.splice(destination, 0, item!);
      return next.map((criterion, position) => ({ ...criterion, position }));
    });
  }

  async function saveDraft(): Promise<TemplateVersion | undefined> {
    if (validation.length) return undefined;
    setSaving(true);
    onError('');
    try {
      const saved = await api.updateTemplateDraft(version.id, { criteria: criteria.map((item, position) => ({ ...item, position })), properties: properties.map((item, position) => ({ ...item, options: (propertyOptionDrafts[item.id] ?? item.options.join(', ')).split(',').map((option) => option.trim()).filter(Boolean), position })), revision: version.revision });
      onSaved(saved);
      return saved;
    } catch (cause) { onError(explainError(cause)); return undefined; }
    finally { setSaving(false); }
  }

  async function publish() {
    setPublishing(true);
    const saved = await saveDraft();
    if (!saved) { setPublishing(false); return; }
    try {
      const published = await api.publishTemplate(saved.id, saved.revision);
      onPublished(published);
    } catch (cause) { onError(explainError(cause)); }
    finally { setPublishing(false); }
  }

  return (
    <div className="criterion-editor">
      <Notice tone="warning"><strong>{en.categories.draftNotice(version.version)}</strong> {en.categories.draftNoticeSuffix}</Notice>
      {validation.length > 0 && <div className="validation-summary" role="alert"><strong>{en.categories.beforePublishing}</strong><ul>{validation.map((message) => <li key={message}>{message}</li>)}</ul></div>}
      <div className="criterion-list">
        {criteria.map((criterion, index) => {
          const id = criterionId(criterion);
          return (
            <article className="criterion-card" key={id}>
              <div className="criterion-number"><span>{index + 1}</span><div><button type="button" onClick={() => move(index, -1)} disabled={index === 0} aria-label={en.categories.moveUp(criterion.name || en.categories.criterionFallback(index + 1).toLowerCase())}>↑</button><button type="button" onClick={() => move(index, 1)} disabled={index === criteria.length - 1} aria-label={en.categories.moveDown(criterion.name || en.categories.criterionFallback(index + 1).toLowerCase())}>↓</button></div></div>
              <div className="criterion-fields">
                <div className="form-grid two-column"><Field label={en.categories.criterionNameLabel} required><input value={criterion.name} onChange={(event) => update(id, { name: event.target.value })} placeholder={en.categories.criterionPlaceholder} /></Field><Field label={en.categories.descriptionLabel}><input value={criterion.description || ''} onChange={(event) => update(id, { description: event.target.value })} placeholder={en.categories.criterionDescriptionPlaceholder} /></Field></div>
                <div className="form-grid scale-grid">
                  <Field label={en.categories.minimum}><input type="number" inputMode="decimal" value={criterion.minValue} onChange={(event) => update(id, { minValue: event.target.value })} /></Field>
                  <Field label={en.categories.maximum}><input type="number" inputMode="decimal" value={criterion.maxValue} onChange={(event) => update(id, { maxValue: event.target.value })} /></Field>
                  <Field label={en.categories.step}><input type="number" inputMode="decimal" min="0" value={criterion.stepValue} onChange={(event) => update(id, { stepValue: event.target.value })} /></Field>
                  <label className="check-field"><input type="checkbox" checked={criterion.required} onChange={(event) => update(id, { required: event.target.checked })} /><span><strong>{en.common.required}</strong><small>{en.categories.mustScore}</small></span></label>
                </div>
              </div>
              <button type="button" className="icon-button danger" onClick={() => setCriteria((items) => items.filter((item) => criterionId(item) !== id).map((item, position) => ({ ...item, position })))} aria-label={en.categories.removeCriterion(criterion.name || en.categories.criterionFallback(index + 1).toLowerCase())}>×</button>
            </article>
          );
        })}
      </div>
      <button type="button" className="add-row-button" onClick={() => setCriteria((items) => [...items, freshCriterion(items.length)])}>{en.categories.addCriterionButton}</button>
      <div className="section-heading property-heading"><div><p className="eyebrow">{en.categories.propertiesEyebrow}</p><h3>{en.categories.propertiesTitle}</h3></div></div>
      <div className="property-list">
        {properties.map((property, index) => <article className="property-card" key={property.id}>
          <div className="form-grid two-column"><Field label={en.categories.propertyName} required><input value={property.name} onChange={(event) => setProperties((items) => items.map((item) => item.id === property.id ? { ...item, name: event.target.value } : item))} placeholder={en.categories.propertyNamePlaceholder} /></Field><Field label={en.categories.propertyType}><select value={property.type} onChange={(event) => setProperties((items) => items.map((item) => item.id === property.id ? { ...item, type: event.target.value as PropertyType, options: event.target.value === 'select' ? item.options : [] } : item))}><option value="text">{en.categories.propertyText}</option><option value="select">{en.categories.propertySelect}</option><option value="checkbox">{en.categories.propertyCheckbox}</option></select></Field></div>
          {property.type === 'select' && <Field label={en.categories.propertyOptions} hint={en.categories.propertyOptionsHint}><input value={propertyOptionDrafts[property.id] ?? property.options.join(', ')} onChange={(event) => { const raw = event.target.value; setPropertyOptionDrafts((drafts) => ({ ...drafts, [property.id]: raw })); setProperties((items) => items.map((item) => item.id === property.id ? { ...item, options: raw.split(',').map((option) => option.trim()).filter(Boolean) } : item)); }} placeholder={en.categories.propertyOptionsPlaceholder} /></Field>}
          <label className="check-field"><input type="checkbox" checked={property.required} onChange={(event) => setProperties((items) => items.map((item) => item.id === property.id ? { ...item, required: event.target.checked } : item))} /><span><strong>{en.common.required}</strong><small>{en.categories.propertyRequiredHint}</small></span></label>
          <button type="button" className="icon-button danger" onClick={() => { setPropertyOptionDrafts((drafts) => { const next = { ...drafts }; delete next[property.id]; return next; }); setProperties((items) => items.filter((item) => item.id !== property.id).map((item, position) => ({ ...item, position }))); }} aria-label={en.categories.removeProperty(property.name || `property ${index + 1}`)}>×</button>
        </article>)}
      </div>
      <button type="button" className="add-row-button" onClick={() => { const property = freshProperty(properties.length); setProperties((items) => [...items, property]); setPropertyOptionDrafts((drafts) => ({ ...drafts, [property.id]: '' })); }}>{en.categories.addProperty}</button>
      <div className="form-actions sticky-actions"><Button variant="secondary" onClick={() => void saveDraft()} disabled={saving || publishing || validation.length > 0}>{saving ? en.categories.saving : en.categories.saveDraft}</Button><Button onClick={() => void publish()} disabled={saving || publishing || validation.length > 0}>{publishing ? en.categories.publishing : en.categories.publishTemplate}</Button></div>
    </div>
  );
}

function PublishedTemplate({ version }: { version: TemplateVersion }) {
  return (
    <div className="published-template">
      <div className="template-meta"><span>{en.categories.publishedAt(formatDateTime(version.publishedAt))}</span><span>{en.categories.criteriaCount(version.criteria.length)}</span></div>
      <ol className="published-criteria">
        {[...version.criteria].sort((a, b) => a.position - b.position).map((criterion) => (
          <li key={criterionId(criterion)}>
            <span className="criterion-order">{criterion.position + 1}</span>
            <div><div className="title-line"><strong>{criterion.name}</strong>{criterion.required ? <Badge tone="info">{en.common.required}</Badge> : <Badge>{en.common.optional}</Badge>}</div><p>{criterion.description || en.categories.noDescription}</p></div>
            <span className="scale-summary">{criterion.minValue} → {criterion.maxValue}<small>{en.categories.stepValue(criterion.stepValue)}</small></span>
          </li>
        ))}
      </ol>
      {(version.properties || []).length > 0 && <div className="published-properties">
        <h4>{en.categories.propertiesTitle}</h4>
        <ul>
          {[...(version.properties || [])].sort((a, b) => a.position - b.position).map((property) => <li key={property.id}><strong>{property.name}</strong><span>{property.type === 'select' ? property.options.join(', ') : property.type}</span>{property.required && <Badge tone="info">{en.common.required}</Badge>}</li>)}
        </ul>
      </div>}
    </div>
  );
}
