import { act, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { ApiProvider } from '../api/context';
import type { Review } from '../api/types';
import { EntitiesPage } from './EntitiesPage';

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

function review(id: string, reviewerName: string, hiddenAt: string | null = null, revision = 3): Review {
  return {
    id,
    entityId: entity.id,
    reviewerId: `reviewer-${id}`,
    reviewer: { id: `reviewer-${id}`, displayName: reviewerName },
    templateVersionId: 'template-1',
    templateVersion: { id: 'template-1', version: 1 },
    reviewedAt: '2026-01-02T00:00:00Z',
    createdAt: '2026-01-02T00:00:00Z',
    status: 'final',
    hiddenAt,
    pictures: [],
    scores: [],
    revision,
  };
}

describe('review visibility', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it('shows hidden history on request and restores it with the current revision', async () => {
    const visible = review('visible', 'Visible reviewer');
    let hidden = review('hidden', 'Hidden reviewer', '2026-01-03T00:00:00Z', 7);
    const reviewRequests: URL[] = [];
    const visibilityWrites: Array<{ hidden: boolean; revision: number }> = [];

    vi.stubGlobal('fetch', vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(String(input), 'http://review-engine.test');
      if (url.pathname.endsWith('/categories')) return json({ items: [category], nextCursor: null });
      if (url.pathname.endsWith('/entities')) return json({ items: [entity], nextCursor: null });
      if (url.pathname.endsWith('/entities/entity-1/reviews')) {
        reviewRequests.push(url);
        return json({
          items: url.searchParams.get('includeHidden') === 'true' ? [visible, hidden] : [visible],
          nextCursor: null,
        });
      }
      if (url.pathname.endsWith('/reviews/hidden/visibility')) {
        const body = JSON.parse(String(init?.body)) as { hidden: boolean; revision: number };
        visibilityWrites.push(body);
        hidden = { ...hidden, hiddenAt: body.hidden ? '2026-01-04T00:00:00Z' : null, revision: body.revision + 1 };
        return json(hidden);
      }
      return json({});
    }));
    const user = userEvent.setup();
    render(<ApiProvider><EntitiesPage /></ApiProvider>);

    expect(await screen.findByText(/by Visible reviewer/i)).toBeInTheDocument();
    expect(screen.queryByText(/by Hidden reviewer/i)).not.toBeInTheDocument();
    expect(reviewRequests[0]?.searchParams.has('includeHidden')).toBe(false);

    await user.click(screen.getByRole('checkbox', { name: 'Show hidden' }));

    const hiddenReviewer = await screen.findByText(/by Hidden reviewer/i);
    const hiddenArticle = hiddenReviewer.closest('article');
    expect(hiddenArticle?.parentElement).toHaveClass('hidden-review');
    expect(within(hiddenArticle!).getByText('Hidden')).toBeInTheDocument();
    expect(reviewRequests.at(-1)?.searchParams.get('includeHidden')).toBe('true');

    await user.click(within(hiddenArticle!).getByRole('button', { name: 'Restore' }));

    await waitFor(() => expect(hiddenArticle?.parentElement).not.toHaveClass('hidden-review'));
    await waitFor(() => expect(reviewRequests).toHaveLength(3));
    expect(visibilityWrites).toEqual([{ hidden: false, revision: 7 }]);
    expect(screen.getByText('Review restored to normal history.')).toBeInTheDocument();
  });

  it('confirms hiding a final review and removes it from normal history', async () => {
    let visible = review('visible', 'Visible reviewer', null, 11);
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(true);
    let visibilityWrite: { hidden: boolean; revision: number } | undefined;

    vi.stubGlobal('fetch', vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(String(input), 'http://review-engine.test');
      if (url.pathname.endsWith('/categories')) return json({ items: [category], nextCursor: null });
      if (url.pathname.endsWith('/entities')) return json({ items: [entity], nextCursor: null });
      if (url.pathname.endsWith('/entities/entity-1/reviews')) return json({ items: visible.hiddenAt ? [] : [visible], nextCursor: null });
      if (url.pathname.endsWith('/reviews/visible/visibility')) {
        visibilityWrite = JSON.parse(String(init?.body)) as { hidden: boolean; revision: number };
        visible = { ...visible, hiddenAt: '2026-01-04T00:00:00Z', revision: 12 };
        return json(visible);
      }
      return json({});
    }));
    const user = userEvent.setup();
    render(<ApiProvider><EntitiesPage /></ApiProvider>);

    const reviewer = await screen.findByText(/by Visible reviewer/i);
    await user.click(within(reviewer.closest('article')!).getByRole('button', { name: 'Hide' }));

    expect(confirm).toHaveBeenCalledWith('Hide this review? It will be excluded from normal history and comparisons, but retained so you can restore it by selecting “Show hidden”.');
    await waitFor(() => expect(screen.queryByText(/by Visible reviewer/i)).not.toBeInTheDocument());
    expect(visibilityWrite).toEqual({ hidden: true, revision: 11 });
    expect(screen.getByText('Review hidden from normal history.')).toBeInTheDocument();
  });

  it('ignores an older page that resolves after the hidden-history filter changes', async () => {
    const visible = review('visible', 'Visible reviewer');
    const hidden = review('hidden', 'Hidden reviewer', '2026-01-03T00:00:00Z');
    const stale = review('stale', 'Stale reviewer');
    let resolveOlder!: (response: Response) => void;
    const olderResponse = new Promise<Response>((resolve) => { resolveOlder = resolve; });
    let olderRequested = false;

    vi.stubGlobal('fetch', vi.fn((input: RequestInfo | URL) => {
      const url = new URL(String(input), 'http://review-engine.test');
      if (url.pathname.endsWith('/categories')) return json({ items: [category], nextCursor: null });
      if (url.pathname.endsWith('/entities')) return json({ items: [entity], nextCursor: null });
      if (url.pathname.endsWith('/entities/entity-1/reviews')) {
        if (url.searchParams.get('cursor') === 'older') {
          olderRequested = true;
          return olderResponse;
        }
        if (url.searchParams.get('includeHidden') === 'true') {
          return json({ items: [visible, hidden], nextCursor: null });
        }
        return json({ items: [visible], nextCursor: 'older' });
      }
      return json({});
    }));
    const user = userEvent.setup();
    render(<ApiProvider><EntitiesPage /></ApiProvider>);

    expect(await screen.findByText(/by Visible reviewer/i)).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: /load older reviews/i }));
    await waitFor(() => expect(olderRequested).toBe(true));
    await user.click(screen.getByRole('checkbox', { name: 'Show hidden' }));
    expect(await screen.findByText(/by Hidden reviewer/i)).toBeInTheDocument();

    await act(async () => {
      resolveOlder(new Response(JSON.stringify({ items: [stale], nextCursor: 'stale-next' }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }));
      await olderResponse;
    });

    expect(screen.queryByText(/by Stale reviewer/i)).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /load older reviews/i })).not.toBeInTheDocument();
  });
});
