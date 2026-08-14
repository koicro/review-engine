import { useEffect, useMemo, useState, type FormEvent } from 'react';
import { useApi } from '../api/context';
import type { Entity, EntityRelation, RelatedEntity, RelationDirection, RelationType } from '../api/types';
import { Badge, Button, Card, Dialog, EmptyState, ErrorPanel, Field, LoadingState, Notice, PageHeader } from '../components/UI';
import { explainError } from '../lib';
import { en } from '../messages';

export function RelationsPage() {
  const { api } = useApi();
  const [entities, setEntities] = useState<Entity[]>([]);
  const [types, setTypes] = useState<RelationType[]>([]);
  const [relations, setRelations] = useState<EntityRelation[]>([]);
  const [relationNextCursor, setRelationNextCursor] = useState<string | null | undefined>();
  const [rootId, setRootId] = useState('');
  const [typeFilter, setTypeFilter] = useState('');
  const [direction, setDirection] = useState<RelationDirection>('both');
  const [maxDepth, setMaxDepth] = useState(2);
  const [related, setRelated] = useState<RelatedEntity[]>([]);
  const [loading, setLoading] = useState(true);
  const [exploring, setExploring] = useState(false);
  const [loadingMoreRelations, setLoadingMoreRelations] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [createRelationOpen, setCreateRelationOpen] = useState(false);
  const [createTypeOpen, setCreateTypeOpen] = useState(false);
  const [refreshKey, setRefreshKey] = useState(0);

  useEffect(() => {
    let active = true; setLoading(true); setError('');
    Promise.all([
      api.listAllEntities({ limit: 100 }),
      api.listAllRelationTypes({ limit: 100 }),
      api.listRelations({ limit: 50 }),
    ]).then(([allEntities, allTypes, relationPage]) => {
      if (!active) return;
      const available = allEntities.filter((entity) => !entity.archivedAt);
      setEntities(available);
      setTypes(allTypes);
      setRelations(relationPage.items);
      setRelationNextCursor(relationPage.nextCursor);
      setRootId((current) => available.some((entity) => entity.id === current) ? current : available[0]?.id || '');
    }).catch((cause) => active && setError(explainError(cause))).finally(() => active && setLoading(false));
    return () => { active = false; };
  }, [api, refreshKey]);

  async function loadMoreRelations() {
    if (!relationNextCursor) return;
    setLoadingMoreRelations(true);
    setError('');
    try {
      const page = await api.listRelations({ cursor: relationNextCursor, limit: 50 });
      setRelations((items) => {
        const existing = new Set(items.map((item) => item.id));
        return [...items, ...page.items.filter((item) => !existing.has(item.id))];
      });
      setRelationNextCursor(page.nextCursor);
    } catch (cause) {
      setError(explainError(cause));
    } finally {
      setLoadingMoreRelations(false);
    }
  }

  async function explore(event?: FormEvent) {
    event?.preventDefault(); if (!rootId) return;
    setExploring(true); setError('');
    try { setRelated(await api.getRelated(rootId, { relationTypeId: typeFilter || undefined, direction, maxDepth })); }
    catch (cause) { setError(explainError(cause)); }
    finally { setExploring(false); }
  }

  const layers = useMemo(() => {
    const grouped = new Map<number, RelatedEntity[]>();
    related.forEach((item) => grouped.set(item.depth, [...(grouped.get(item.depth) || []), item]));
    return [...grouped.entries()].sort(([a], [b]) => a - b);
  }, [related]);
  const root = entities.find((entity) => entity.id === rootId);

  return (
    <div className="page-stack">
      <PageHeader eyebrow={en.relations.eyebrow} title={en.relations.title} description={en.relations.description} actions={<div className="page-actions"><Button variant="secondary" onClick={() => setCreateTypeOpen(true)}>{en.relations.newType}</Button><Button onClick={() => setCreateRelationOpen(true)} disabled={!types.length || entities.length < 2}>{en.relations.connectEntities}</Button></div>} />
      {notice && <Notice tone="success">{notice}</Notice>}
      {error && <ErrorPanel message={error} onRetry={() => setRefreshKey((value) => value + 1)} />}
      {loading ? <LoadingState label={en.relations.loadingMap} /> : (
        <div className="relations-grid">
          <Card className="explore-controls">
            <div className="section-heading"><div><p className="eyebrow">{en.relations.explorer}</p><h2>{en.relations.traceConnections}</h2></div></div>
            <form className="form-stack" onSubmit={explore}>
              <Field label={en.relations.startFrom}><select value={rootId} onChange={(event) => { setRootId(event.target.value); setRelated([]); }}><option value="" disabled>{en.relations.selectEntity}</option>{entities.map((entity) => <option key={entity.id} value={entity.id}>{entity.name}</option>)}</select></Field>
              <Field label={en.relations.relationType}><select value={typeFilter} onChange={(event) => setTypeFilter(event.target.value)}><option value="">{en.relations.allTypes}</option>{types.map((type) => <option key={type.id} value={type.id}>{type.forwardLabel} / {type.inverseLabel}</option>)}</select></Field>
              <fieldset className="segmented-field"><legend>{en.relations.direction}</legend>{(['both', 'outgoing', 'incoming'] as RelationDirection[]).map((value) => <label key={value}><input type="radio" name="direction" checked={direction === value} onChange={() => setDirection(value)} /><span>{en.relations.directionLabel(value)}</span></label>)}</fieldset>
              <Field label={en.relations.maximumDepth} hint={en.relations.depthHint}><input type="number" min="1" max="5" value={maxDepth} onChange={(event) => setMaxDepth(Number(event.target.value))} /></Field>
              <Button type="submit" disabled={!rootId || exploring}>{exploring ? en.relations.exploring : en.relations.explore}</Button>
            </form>
            <hr />
            <div className="type-key"><h3>{en.relations.relationTypes}</h3>{types.length === 0 ? <p>{en.relations.noTypes}</p> : <ul>{types.map((type) => <li key={type.id}><span><strong>{type.forwardLabel}</strong><small>{en.relations.reverseLabel(type.key, type.inverseLabel)}</small></span>{type.hierarchical && <Badge tone="info">{en.relations.hierarchy}</Badge>}</li>)}</ul>}</div>
          </Card>

          <div className="relation-output">
            <Card className="relation-map-card">
              <div className="section-heading"><div><p className="eyebrow">{en.relations.neighborhood}</p><h2>{root ? root.name : en.relations.chooseEntity}</h2></div>{related.length > 0 && <Badge tone="success">{en.relations.connected(related.length)}</Badge>}</div>
              {exploring ? <LoadingState label={en.relations.tracing} /> : layers.length === 0 ? <EmptyState title={en.relations.noResult} description={en.relations.noResultDescription} action={rootId && <Button variant="secondary" onClick={() => void explore()}>{en.relations.exploreNow}</Button>} /> : (
                <div className="relation-layers"><div className="root-node"><span className="entity-monogram" aria-hidden="true">{root?.name.slice(0, 1).toUpperCase()}</span><strong>{root?.name}</strong><Badge tone="info">{en.relations.start}</Badge></div>{layers.map(([depth, items]) => <section key={depth}><h3><span>{en.relations.depth(depth)}</span><i /></h3><div className="relation-node-grid">{items.map((item, index) => <article key={`${item.entity.id}-${index}`}><span className="entity-monogram" aria-hidden="true">{item.entity.name.slice(0, 1).toUpperCase()}</span><div><strong>{item.entity.name}</strong><small>{item.relationType ? item.direction === 'incoming' ? item.relationType.inverseLabel : item.relationType.forwardLabel : item.direction || en.relations.related}</small></div><Badge>{item.direction === 'incoming' ? en.relations.incoming : en.relations.outgoing}</Badge></article>)}</div></section>)}</div>
              )}
            </Card>
            <Card>
              <div className="section-heading"><div><p className="eyebrow">{en.relations.edges}</p><h2>{en.relations.connections}</h2></div>{relations.length > 0 && <Badge>{en.relations.loaded(relations.length, Boolean(relationNextCursor))}</Badge>}</div>
              {relations.length === 0 ? <EmptyState title={en.relations.noConnections} description={en.relations.noConnectionsDescription} action={types.length > 0 && <Button variant="secondary" onClick={() => setCreateRelationOpen(true)}>{en.relations.connectEntities}</Button>} /> : (
                <>
                  <ul className="relation-list">{relations.map((relation) => { const source = relation.sourceEntity || entities.find((entity) => entity.id === relation.sourceEntityId); const target = relation.targetEntity || entities.find((entity) => entity.id === relation.targetEntityId); const type = relation.relationType || types.find((item) => item.id === relation.relationTypeId); return <li key={relation.id}><strong>{source?.name || en.common.unknownEntity}</strong><span>— {type?.forwardLabel || en.relations.relatesTo} →</span><strong>{target?.name || en.common.unknownEntity}</strong><button className="text-button danger-text relation-delete" onClick={async () => { if (!window.confirm(en.relations.deleteConfirmation)) return; try { await api.deleteRelation(relation.id); setRelations((items) => items.filter((item) => item.id !== relation.id)); setNotice(en.relations.deleted); setRelated([]); } catch (cause) { setError(explainError(cause)); } }}>{en.common.actions.delete}</button></li>; })}</ul>
                  {relationNextCursor && <Button variant="quiet" className="load-more" onClick={() => void loadMoreRelations()} disabled={loadingMoreRelations}>{loadingMoreRelations ? en.relations.loadingMore : en.relations.loadMore}</Button>}
                </>
              )}
            </Card>
          </div>
        </div>
      )}
      <CreateRelationDialog open={createRelationOpen} entities={entities} types={types} onClose={() => setCreateRelationOpen(false)} onCreated={(relation) => { setRelations((items) => [relation, ...items]); setCreateRelationOpen(false); setNotice(en.relations.connectedNotice); }} />
      <CreateRelationTypeDialog open={createTypeOpen} onClose={() => setCreateTypeOpen(false)} onCreated={(type) => { setTypes((items) => [...items, type]); setCreateTypeOpen(false); setNotice(en.relations.typeCreated(type.forwardLabel)); }} />
    </div>
  );
}

function CreateRelationDialog({ open, entities, types, onClose, onCreated }: { open: boolean; entities: Entity[]; types: RelationType[]; onClose: () => void; onCreated: (relation: EntityRelation) => void }) {
  const { api } = useApi(); const [source, setSource] = useState(''); const [target, setTarget] = useState(''); const [typeId, setTypeId] = useState(''); const [error, setError] = useState(''); const [saving, setSaving] = useState(false);
  useEffect(() => { if (open) { setSource(entities[0]?.id || ''); setTarget(entities[1]?.id || ''); setTypeId(types[0]?.id || ''); setError(''); } }, [open, entities, types]);
  async function submit(event: FormEvent) { event.preventDefault(); if (source === target) return setError(en.relations.differentEntities); setSaving(true); setError(''); try { onCreated(await api.createRelation({ sourceEntityId: source, targetEntityId: target, relationTypeId: typeId })); } catch (cause) { setError(explainError(cause)); } finally { setSaving(false); } }
  const type = types.find((item) => item.id === typeId);
  return <Dialog open={open} onClose={onClose} title={en.relations.connectEntities} description={en.relations.connectDescription}><form className="form-stack" onSubmit={submit}>{error && <ErrorPanel message={error} />}<Field label={en.relations.sourceEntity}><select value={source} onChange={(event) => setSource(event.target.value)}>{entities.map((entity) => <option key={entity.id} value={entity.id}>{entity.name}</option>)}</select></Field><Field label={en.relations.relation}><select value={typeId} onChange={(event) => setTypeId(event.target.value)}>{types.map((item) => <option key={item.id} value={item.id}>{item.forwardLabel}</option>)}</select></Field><Field label={en.relations.targetEntity}><select value={target} onChange={(event) => setTarget(event.target.value)}>{entities.map((entity) => <option key={entity.id} value={entity.id}>{entity.name}</option>)}</select></Field>{type && <div className="relation-preview"><span>{entities.find((item) => item.id === source)?.name || en.relations.source}</span><strong>{type.forwardLabel}</strong><span>{entities.find((item) => item.id === target)?.name || en.relations.target}</span></div>}<div className="form-actions"><Button type="button" variant="quiet" onClick={onClose}>{en.common.actions.cancel}</Button><Button type="submit" disabled={saving || !source || !target || !typeId || source === target}>{saving ? en.relations.connecting : en.relations.createConnection}</Button></div></form></Dialog>;
}

function CreateRelationTypeDialog({ open, onClose, onCreated }: { open: boolean; onClose: () => void; onCreated: (type: RelationType) => void }) {
  const { api } = useApi(); const [key, setKey] = useState(''); const [forward, setForward] = useState(''); const [inverse, setInverse] = useState(''); const [hierarchical, setHierarchical] = useState(false); const [error, setError] = useState(''); const [saving, setSaving] = useState(false);
  async function submit(event: FormEvent) { event.preventDefault(); setSaving(true); setError(''); try { const type = await api.createRelationType({ key: key.trim(), forwardLabel: forward.trim(), inverseLabel: inverse.trim(), hierarchical }); onCreated(type); setKey(''); setForward(''); setInverse(''); setHierarchical(false); } catch (cause) { setError(explainError(cause)); } finally { setSaving(false); } }
  return <Dialog open={open} onClose={onClose} title={en.relations.createTypeTitle} description={en.relations.createTypeDescription} size="small"><form className="form-stack" onSubmit={submit}>{error && <ErrorPanel message={error} />}<Field label={en.relations.stableKey} hint={en.relations.stableKeyHint}><input value={key} onChange={(event) => setKey(event.target.value.replace(/[^a-z0-9_]/g, ''))} placeholder={en.relations.offers} pattern="[a-z0-9_]+" required /></Field><Field label={en.relations.forwardLabel}><input value={forward} onChange={(event) => setForward(event.target.value)} placeholder={en.relations.offers} required /></Field><Field label={en.relations.inverseLabel}><input value={inverse} onChange={(event) => setInverse(event.target.value)} placeholder={en.relations.offeredBy} required /></Field><label className="check-field"><input type="checkbox" checked={hierarchical} onChange={(event) => setHierarchical(event.target.checked)} /><span><strong>{en.relations.hierarchical}</strong><small>{en.relations.hierarchicalHint}</small></span></label><div className="form-actions"><Button type="button" variant="quiet" onClick={onClose}>{en.common.actions.cancel}</Button><Button type="submit" disabled={saving || !key || !forward.trim() || !inverse.trim()}>{saving ? en.relations.creating : en.relations.createType}</Button></div></form></Dialog>;
}
