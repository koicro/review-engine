import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { ApiProvider } from '../api/context';
import type { EntityRelation, Review } from '../api/types';
import { EntitiesPage } from './EntitiesPage';
import { RelationsPage } from './RelationsPage';

function json(body: unknown) {
  return Promise.resolve(new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  }));
}

const category = {
  id: 'category-1',
  name: 'Coffee',
  activeTemplateVersionId: null,
  archivedAt: null,
  createdAt: '2026-01-01T00:00:00Z',
  updatedAt: '2026-01-01T00:00:00Z',
  revision: 0,
};

const entity = {
  id: 'entity-1',
  categoryId: category.id,
  category: { id: category.id, name: category.name },
  name: 'North blend',
  description: null,
  createdAt: '2026-01-01T00:00:00Z',
  updatedAt: '2026-01-01T00:00:00Z',
  archivedAt: null,
  reviewCount: 2,
  revision: 0,
};

function review(id: string, status: Review['status'], reviewerName: string): Review {
  return {
    id,
    entityId: entity.id,
    reviewerId: `reviewer-${id}`,
    reviewer: { id: `reviewer-${id}`, displayName: reviewerName },
    templateVersionId: 'template-1',
    templateVersion: { id: 'template-1', version: 1 },
    reviewedAt: status === 'final' ? '2026-01-02T00:00:00Z' : '2026-01-01T00:00:00Z',
    createdAt: '2026-01-01T00:00:00Z',
    status,
    pictures: [],
    scores: [],
    revision: 0,
  };
}

function relation(index: number): EntityRelation {
  return {
    id: `relation-${index}`,
    sourceEntityId: 'entity-1',
    targetEntityId: `target-${index}`,
    relationTypeId: 'type-1',
    sourceEntity: { id: 'entity-1', categoryId: category.id, name: 'Source' },
    targetEntity: { id: `target-${index}`, categoryId: category.id, name: `Target ${index}` },
    relationType: {
      id: 'type-1',
      key: 'offers',
      forwardLabel: 'offers',
      inverseLabel: 'offered by',
      hierarchical: false,
    },
  };
}

describe('paged workflows', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('loads older reviews and includes superseded history', async () => {
    vi.stubGlobal('fetch', vi.fn((input: RequestInfo | URL) => {
      const url = new URL(String(input), 'http://review-engine.test');
      if (url.pathname.endsWith('/categories')) return json({ items: [category], nextCursor: null });
      if (url.pathname.endsWith('/entities')) return json({ items: [entity], nextCursor: null });
      if (url.pathname.endsWith('/entities/entity-1/reviews')) {
        if (url.searchParams.get('cursor') === 'older') {
          return json({ items: [review('old', 'superseded', 'Older reviewer')], nextCursor: null });
        }
        expect(url.searchParams.get('includeSuperseded')).toBe('true');
        return json({ items: [review('new', 'final', 'New reviewer')], nextCursor: 'older' });
      }
      return json({});
    }));
    const user = userEvent.setup();
    render(<ApiProvider><EntitiesPage /></ApiProvider>);

    expect(await screen.findByText(/by New reviewer/i)).toBeInTheDocument();
    expect(screen.queryByText(/by Older reviewer/i)).not.toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: /load older reviews/i }));

    expect(await screen.findByText(/by Older reviewer/i)).toBeInTheDocument();
    expect(screen.getByText('superseded')).toBeInTheDocument();
  });

  it('shows every edge in a page and loads the next relation page', async () => {
    const firstRelations = Array.from({ length: 13 }, (_, index) => relation(index + 1));
    vi.stubGlobal('fetch', vi.fn((input: RequestInfo | URL) => {
      const url = new URL(String(input), 'http://review-engine.test');
      if (url.pathname.endsWith('/relation-types')) {
        return json({ items: [relation(1).relationType], nextCursor: null });
      }
      if (url.pathname.endsWith('/entities')) {
        if (url.searchParams.get('cursor') === 'entities-2') {
          return json({ items: [{ ...entity, id: 'entity-2', name: 'Second entity' }], nextCursor: null });
        }
        return json({ items: [entity], nextCursor: 'entities-2' });
      }
      if (url.pathname.endsWith('/relations')) {
        if (url.searchParams.get('cursor') === 'relations-2') {
          return json({ items: [relation(14)], nextCursor: null });
        }
        return json({ items: firstRelations, nextCursor: 'relations-2' });
      }
      return json({});
    }));
    const user = userEvent.setup();
    render(<ApiProvider><RelationsPage /></ApiProvider>);

    expect(await screen.findByText('Target 13')).toBeInTheDocument();
    expect(screen.queryByText('Target 14')).not.toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: /load more connections/i }));

    expect(await screen.findByText('Target 14')).toBeInTheDocument();
    expect(screen.getAllByRole('button', { name: 'Delete' })).toHaveLength(14);
  });
});
