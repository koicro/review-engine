export type Id = string;
export type IsoDateTime = string;

export interface Page<T> {
  items: T[];
  nextCursor?: string | null;
}

export interface Category {
  id: Id;
  name: string;
  description?: string | null;
  activeTemplateVersionId?: Id | null;
  activeTemplateVersion?: TemplateVersion | null;
  archivedAt?: IsoDateTime | null;
  entityCount?: number;
  createdAt?: IsoDateTime;
  updatedAt?: IsoDateTime;
  revision?: number;
}

export type TemplateStatus = 'draft' | 'published' | 'retired';

export interface Criterion {
  id: Id;
  criterionId?: Id;
  name: string;
  description?: string | null;
  minValue: number | string;
  maxValue: number | string;
  stepValue: number | string;
  position: number;
  required: boolean;
}

export interface TemplateVersion {
  id: Id;
  categoryId: Id;
  version: number;
  status: TemplateStatus;
  criteria: Criterion[];
  publishedAt?: IsoDateTime | null;
  createdAt?: IsoDateTime;
  revision: number;
}

export interface TemplateSummary {
  id: Id;
  version: number;
}

export interface Entity {
  id: Id;
  categoryId: Id;
  category?: Pick<Category, 'id' | 'name'>;
  name: string;
  description?: string | null;
  createdAt: IsoDateTime;
  updatedAt: IsoDateTime;
  archivedAt?: IsoDateTime | null;
  latestReviewedAt?: IsoDateTime | null;
  reviewCount?: number;
  revision?: number;
}

export interface EntitySummary {
  id: Id;
  categoryId: Id;
  name: string;
}

export type ReviewStatus = 'draft' | 'final' | 'superseded';

export interface Score {
  criterionId: Id;
  criterionName?: string;
  tickIndex: number;
  displayValue?: number | string;
  normalizedValue?: number;
}

export interface Reviewer {
  id: Id;
  displayName: string;
  archivedAt?: IsoDateTime | null;
}

export interface Review {
  id: Id;
  entityId: Id;
  reviewerId?: Id;
  reviewer?: Reviewer;
  templateVersionId: Id;
  templateVersion?: TemplateVersion | TemplateSummary;
  reviewedAt: IsoDateTime;
  createdAt: IsoDateTime;
  status: ReviewStatus;
  supersedesReviewId?: Id | null;
  hiddenAt?: IsoDateTime | null;
  scores: Score[];
  revision: number;
}

export type Aggregation = 'latest' | 'mean' | 'history';

export interface CriterionProjection {
  criterionId: Id;
  name: string;
  missing: boolean;
  displayValue?: number | string | null;
  normalizedValue?: number | null;
  minValue?: number | string;
  maxValue?: number | string;
  sampleCount?: number;
}

export interface ComparisonResult {
  entityId: Id;
  entity?: EntitySummary;
  entityName?: string;
  reviewCount: number;
  lastReviewedAt?: IsoDateTime | null;
  criteria: CriterionProjection[];
  overallNormalizedValue?: number | null;
  history?: Review[];
}

export interface ComparisonResponse {
  categoryId: Id;
  aggregation: Aggregation;
  criteria?: Array<Pick<Criterion, 'id' | 'name' | 'position'>>;
  entities: ComparisonResult[];
}

export interface RelationType {
  id: Id;
  key: string;
  forwardLabel: string;
  inverseLabel: string;
  hierarchical: boolean;
}

export interface EntityRelation {
  id: Id;
  sourceEntityId: Id;
  targetEntityId: Id;
  relationTypeId: Id;
  sourceEntity?: EntitySummary;
  targetEntity?: EntitySummary;
  relationType?: RelationType;
  createdAt?: IsoDateTime;
}

export type RelationDirection = 'outgoing' | 'incoming' | 'both';

export interface RelatedEntity {
  entity: EntitySummary;
  relation?: EntityRelation;
  relationType?: RelationType;
  direction?: 'outgoing' | 'incoming';
  depth: number;
  path?: Id[];
}

export interface ImportValidation {
  valid: boolean;
  errors: Array<{ path?: string; code?: string; message: string }>;
  counts?: Record<string, number>;
  formatVersion?: string;
}

export interface AccessToken {
  id: Id;
  name: string;
  createdAt: IsoDateTime;
  revokedAt?: IsoDateTime | null;
}

export interface IssuedAccessToken {
  token: AccessToken;
  secret: string;
}

export interface ApiProblem {
  code?: string;
  message?: string;
  details?: unknown;
}

export interface ReviewInput {
  reviewedAt: string;
  reviewerId?: Id;
  scores: Array<{ criterionId: Id; tickIndex: number }>;
  finalize?: boolean;
}
