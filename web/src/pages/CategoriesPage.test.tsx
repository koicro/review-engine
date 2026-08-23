import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { ApiProvider } from '../api/context';
import type { Category, TemplateVersion } from '../api/types';
import { CategoriesPage } from './CategoriesPage';

function json(body: unknown, status = 200) {
  return Promise.resolve(new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  }));
}

const category: Category = {
  id: 'category-1',
  name: 'Coffee',
  activeTemplateVersionId: null,
  archivedAt: null,
  createdAt: '2026-01-01T00:00:00Z',
  updatedAt: '2026-01-01T00:00:00Z',
  revision: 0,
};

const draft: TemplateVersion = {
  id: 'template-1',
  categoryId: category.id,
  version: 1,
  status: 'draft',
  criteria: [],
  createdAt: '2026-01-01T00:00:00Z',
  revision: 0,
};

describe('category templates', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('creates the first template as an empty draft before editing criteria', async () => {
    let createBody: unknown;
    vi.stubGlobal('fetch', vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(String(input), 'http://review-engine.test');
      if (url.pathname.endsWith('/categories') && init?.method !== 'POST') {
        return json({ items: [category], nextCursor: null });
      }
      if (url.pathname.endsWith('/categories/category-1/template-versions')) {
        if (init?.method === 'POST') {
          createBody = JSON.parse(String(init.body));
          return json(draft, 201);
        }
        return json({ items: [], nextCursor: null });
      }
      return json({});
    }));
    const user = userEvent.setup();
    render(<ApiProvider><CategoriesPage /></ApiProvider>);

    const createButtons = await screen.findAllByRole('button', { name: 'Create template' });
    await user.click(createButtons[0]!);

    expect(await screen.findByText('Template v1 draft created.')).toBeInTheDocument();
    expect(screen.getByText('Draft v1')).toBeInTheDocument();
    expect(createBody).toEqual({});
  });
});
