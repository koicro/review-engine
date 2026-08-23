import type {
  Aggregation,
  AccessToken,
  ApiProblem,
  Category,
  ComparisonResponse,
  Criterion,
  Entity,
  EntityRelation,
  Id,
  ImportValidation,
  IssuedAccessToken,
  Page,
  RelatedEntity,
  RelationDirection,
  RelationType,
  Review,
  ReviewInput,
  TemplateVersion,
} from './types';
import { en } from '../messages';

export interface ApiClientOptions {
  baseUrl?: string;
  token?: string;
  fetchImpl?: typeof fetch;
  onUnauthorized?: () => void;
}

export class ApiError extends Error {
  readonly status: number;
  readonly code: string;
  readonly details?: unknown;

  constructor(status: number, problem: ApiProblem = {}) {
    super(en.errors.requestFailedStatus(status));
    this.name = 'ApiError';
    this.status = status;
    this.code = problem.code || `HTTP_${status}`;
    this.details = problem.details;
  }
}

export async function collectAllPages<T>(
  loadPage: (cursor?: string) => Promise<Page<T>>,
): Promise<T[]> {
  const items: T[] = [];
  const seenCursors = new Set<string>();
  let cursor: string | undefined;

  do {
    const page = await loadPage(cursor);
    items.push(...page.items);
    const nextCursor = page.nextCursor || undefined;
    if (nextCursor && seenCursors.has(nextCursor)) {
      throw new Error(en.errors.repeatedCursor);
    }
    if (nextCursor) seenCursors.add(nextCursor);
    cursor = nextCursor;
  } while (cursor);

  return items;
}

type QueryValue = string | number | boolean | null | undefined | Array<string | number>;

export function buildQuery(values: Record<string, QueryValue>): string {
  const params = new URLSearchParams();
  Object.entries(values).forEach(([key, raw]) => {
    if (raw === undefined || raw === null || raw === '') return;
    const list = Array.isArray(raw) ? raw : [raw];
    list.forEach((value) => params.append(key, String(value)));
  });
  const query = params.toString();
  return query ? `?${query}` : '';
}

function asPage<T>(value: Page<T> | T[]): Page<T> {
  return Array.isArray(value) ? { items: value } : value;
}

function normalizeBaseUrl(value: string): string {
  const trimmed = value.trim() || '/api/v1';
  return trimmed.endsWith('/') ? trimmed.slice(0, -1) : trimmed;
}

function fileNameFrom(response: Response): string {
  const disposition = response.headers.get('content-disposition');
  const match = disposition?.match(/filename\*?=(?:UTF-8''|\")?([^";]+)/i);
  return match ? decodeURIComponent(match[1]!.replace(/"$/, '')) : 'review-engine-export.json';
}

export class ApiClient {
  readonly baseUrl: string;
  private readonly token?: string;
  private readonly fetchImpl: typeof fetch;
  private readonly onUnauthorized?: () => void;

  constructor(options: ApiClientOptions = {}) {
    this.baseUrl = normalizeBaseUrl(options.baseUrl ?? '/api/v1');
    this.token = options.token?.trim() || undefined;
    this.fetchImpl = options.fetchImpl ?? globalThis.fetch.bind(globalThis);
    this.onUnauthorized = options.onUnauthorized;
  }

  async request<T>(path: string, init: RequestInit = {}): Promise<T> {
    const headers = new Headers(init.headers);
    headers.set('Accept', 'application/json');
    if (init.body !== undefined && !(init.body instanceof FormData)) {
      headers.set('Content-Type', 'application/json');
    }
    if (this.token) headers.set('Authorization', `Bearer ${this.token}`);

    const response = await this.fetchImpl(`${this.baseUrl}${path}`, {
      ...init,
      credentials: 'same-origin',
      headers,
    });

    if (!response.ok) {
      let problem: ApiProblem = {};
      try {
        problem = (await response.json()) as ApiProblem;
      } catch {
        problem.message = response.statusText;
      }
      if (response.status === 401) this.onUnauthorized?.();
      throw new ApiError(response.status, problem);
    }

    if (response.status === 204) return undefined as T;
    return (await response.json()) as T;
  }

  createSession(token: string) {
    return this.request<void>('/session', {
      method: 'POST',
      body: JSON.stringify({ token }),
    });
  }

  deleteSession() {
    return this.request<void>('/session', { method: 'DELETE' });
  }

  async verifySession() {
    await this.listCategories({ limit: 1 });
  }

  listCategories(options: { cursor?: string; includeArchived?: boolean; limit?: number } = {}) {
    return this.request<Page<Category> | Category[]>(
      `/categories${buildQuery(options)}`,
    ).then(asPage);
  }

  listAllCategories(options: { includeArchived?: boolean; limit?: number } = {}) {
    return collectAllPages((cursor) => this.listCategories({ ...options, cursor }));
  }

  createCategory(input: { name: string; description?: string }) {
    return this.request<Category>('/categories', {
      method: 'POST',
      body: JSON.stringify(input),
    });
  }

  updateCategory(id: Id, input: Partial<Pick<Category, 'name' | 'description' | 'revision'>> & { archived?: boolean }) {
    return this.request<Category>(`/categories/${id}`, {
      method: 'PATCH',
      body: JSON.stringify(input),
    });
  }

  deleteCategory(id: Id) {
    return this.request<void>(`/categories/${id}`, { method: 'DELETE' });
  }

  listTemplateVersions(categoryId: Id) {
    return this.request<Page<TemplateVersion> | TemplateVersion[]>(
      `/categories/${categoryId}/template-versions`,
    ).then(asPage);
  }

  getTemplateVersion(versionId: Id) {
    return this.request<TemplateVersion>(`/template-versions/${versionId}`);
  }

  createTemplateDraft(categoryId: Id, criteria?: Criterion[]) {
    return this.request<TemplateVersion>(`/categories/${categoryId}/template-versions`, {
      method: 'POST',
      body: JSON.stringify(criteria ? { criteria: criteria.map(criterionWrite) } : {}),
    });
  }

  updateTemplateDraft(versionId: Id, input: { criteria: Criterion[]; revision: number }) {
    return this.request<TemplateVersion>(`/template-versions/${versionId}`, {
      method: 'PATCH',
      body: JSON.stringify({
        ...input,
        criteria: input.criteria.map(criterionWrite),
      }),
    });
  }

  publishTemplate(versionId: Id, revision: number) {
    return this.request<TemplateVersion>(`/template-versions/${versionId}/publish`, {
      method: 'POST',
      body: JSON.stringify({ revision }),
    });
  }

  listEntities(options: {
    categoryId?: Id;
    query?: string;
    cursor?: string;
    includeArchived?: boolean;
    limit?: number;
  } = {}) {
    return this.request<Page<Entity> | Entity[]>(`/entities${buildQuery(options)}`).then(asPage);
  }

  listAllEntities(options: {
    categoryId?: Id;
    query?: string;
    includeArchived?: boolean;
    limit?: number;
  } = {}) {
    return collectAllPages((cursor) => this.listEntities({ ...options, cursor }));
  }

  getEntity(id: Id) {
    return this.request<Entity>(`/entities/${id}`);
  }

  createEntity(input: { categoryId: Id; name: string; description?: string }) {
    return this.request<Entity>('/entities', { method: 'POST', body: JSON.stringify(input) });
  }

  updateEntity(id: Id, input: Partial<Pick<Entity, 'name' | 'description' | 'categoryId' | 'revision'>> & { archived?: boolean }) {
    return this.request<Entity>(`/entities/${id}`, {
      method: 'PATCH',
      body: JSON.stringify(input),
    });
  }

  deleteEntity(id: Id) {
    return this.request<void>(`/entities/${id}`, { method: 'DELETE' });
  }

  listReviews(entityId: Id, options: { cursor?: string; includeSuperseded?: boolean; includeHidden?: boolean; limit?: number } = {}) {
    return this.request<Page<Review> | Review[]>(
      `/entities/${entityId}/reviews${buildQuery(options)}`,
    ).then(asPage);
  }

  createReview(entityId: Id, input: ReviewInput) {
    return this.request<Review>(`/entities/${entityId}/reviews`, {
      method: 'POST',
      body: JSON.stringify(input),
    });
  }

  updateReview(reviewId: Id, input: ReviewInput & { revision?: number }) {
    return this.request<Review>(`/reviews/${reviewId}`, {
      method: 'PATCH',
      body: JSON.stringify(input),
    });
  }

  finalizeReview(reviewId: Id, input: Pick<ReviewInput, 'scores'> & { revision: number }) {
    return this.request<Review>(`/reviews/${reviewId}/finalize`, {
      method: 'POST',
      body: JSON.stringify(input),
    });
  }

  reviseReview(reviewId: Id, input: ReviewInput & { revision: number }) {
    return this.request<Review>(`/reviews/${reviewId}/revisions`, {
      method: 'POST',
      body: JSON.stringify(input),
    });
  }

  deleteDraftReview(reviewId: Id, revision: number) {
    return this.request<void>(`/reviews/${reviewId}?revision=${encodeURIComponent(revision)}`, { method: 'DELETE' });
  }

  updateReviewVisibility(reviewId: Id, input: { hidden: boolean; revision: number }) {
    return this.request<Review>(`/reviews/${reviewId}/visibility`, {
      method: 'PATCH',
      body: JSON.stringify(input),
    });
  }

  compare(input: {
    categoryId: Id;
    entityIds: Id[];
    aggregation: Aggregation;
    from?: string;
    to?: string;
    reviewerId?: Id;
  }) {
    return this.request<ComparisonResponse>(
      `/comparisons${buildQuery({
        categoryId: input.categoryId,
        entityId: input.entityIds,
        aggregation: input.aggregation,
        from: input.from,
        to: input.to,
        reviewerId: input.reviewerId,
      })}`,
    );
  }

  listRelationTypes(options: { cursor?: string; limit?: number } = {}) {
    return this.request<Page<RelationType> | RelationType[]>(
      `/relation-types${buildQuery(options)}`,
    ).then(asPage);
  }

  listAllRelationTypes(options: { limit?: number } = {}) {
    return collectAllPages((cursor) => this.listRelationTypes({ ...options, cursor }));
  }

  createRelationType(input: Omit<RelationType, 'id'>) {
    return this.request<RelationType>('/relation-types', {
      method: 'POST',
      body: JSON.stringify(input),
    });
  }

  listRelations(options: { entityId?: Id; relationTypeId?: Id; cursor?: string; limit?: number } = {}) {
    return this.request<Page<EntityRelation> | EntityRelation[]>(
      `/relations${buildQuery(options)}`,
    ).then(asPage);
  }

  createRelation(input: Pick<EntityRelation, 'sourceEntityId' | 'targetEntityId' | 'relationTypeId'>) {
    return this.request<EntityRelation>('/relations', {
      method: 'POST',
      body: JSON.stringify(input),
    });
  }

  deleteRelation(id: Id) {
    return this.request<void>(`/relations/${id}`, { method: 'DELETE' });
  }

  getRelated(entityId: Id, options: {
    relationTypeId?: Id;
    direction?: RelationDirection;
    maxDepth?: number;
  } = {}) {
    return this.request<{ items: RelatedEntity[] } | RelatedEntity[]>(
      `/entities/${entityId}/related${buildQuery(options)}`,
    ).then((value) => Array.isArray(value) ? value : value.items);
  }

  async exportAll(): Promise<{ blob: Blob; fileName: string }> {
    const headers = new Headers({ Accept: 'application/json' });
    if (this.token) headers.set('Authorization', `Bearer ${this.token}`);
    const response = await this.fetchImpl(`${this.baseUrl}/exports`, {
      method: 'POST',
      credentials: 'same-origin',
      headers,
    });
    if (!response.ok) {
      let problem: ApiProblem = {};
      try { problem = (await response.json()) as ApiProblem; } catch { problem.message = response.statusText; }
      if (response.status === 401) this.onUnauthorized?.();
      throw new ApiError(response.status, problem);
    }
    return { blob: await response.blob(), fileName: fileNameFrom(response) };
  }

  validateImport(payload: unknown) {
    return this.request<ImportValidation>('/imports/validate', {
      method: 'POST',
      body: JSON.stringify(payload),
    });
  }

  importAll(payload: unknown) {
    return this.request<{ imported: boolean; counts?: Record<string, number> }>('/imports', {
      method: 'POST',
      body: JSON.stringify(payload),
    });
  }

  listAccessTokens() {
    return this.request<Page<AccessToken> | AccessToken[]>('/access-tokens').then(asPage);
  }

  issueAccessToken(name: string) {
    return this.request<IssuedAccessToken>('/access-tokens', {
      method: 'POST',
      body: JSON.stringify({ name }),
    });
  }

  revokeAccessToken(id: Id) {
    return this.request<AccessToken>(`/access-tokens/${id}/revoke`, { method: 'POST' });
  }
}

function criterionWrite(criterion: Criterion): Criterion {
  return {
    ...criterion,
    minValue: String(criterion.minValue),
    maxValue: String(criterion.maxValue),
    stepValue: String(criterion.stepValue),
  };
}
