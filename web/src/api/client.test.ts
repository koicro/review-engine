import { ApiClient, ApiError, buildQuery } from './client';

function jsonResponse(body: unknown, init: ResponseInit = {}) {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'content-type': 'application/json' },
    ...init,
  });
}

describe('ApiClient', () => {
  it('builds repeated query parameters and omits empty values', () => {
    expect(buildQuery({
      categoryId: 'cat-1',
      entityId: ['entity-1', 'entity-2'],
      from: '',
      cursor: undefined,
      includeArchived: false,
    })).toBe('?categoryId=cat-1&entityId=entity-1&entityId=entity-2&includeArchived=false');
  });

  it('resolves resource paths against a custom API origin and rejects unsafe URLs', () => {
    const client = new ApiClient({ baseUrl: 'https://api.example.test/custom/v1' });

    expect(client.resolveResourceUrl('/api/v1/reviews/review-1/pictures/picture-1'))
      .toBe('https://api.example.test/custom/v1/reviews/review-1/pictures/picture-1');
    expect(client.resolveResourceUrl('reviews/review-1/pictures/picture-1'))
      .toBe('https://api.example.test/custom/v1/reviews/review-1/pictures/picture-1');
    expect(client.resolveResourceUrl('javascript:alert(1)')).toBe('');
    expect(client.resolveResourceUrl('//attacker.example/picture.jpg')).toBe('');
    expect(client.resolveResourceUrl('https://attacker.example/picture.jpg')).toBe('');
  });

  it('supports an explicit bearer token for non-browser API clients', async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(jsonResponse([
      { id: 'cat-1', name: 'Coffee', activeTemplateVersionId: null },
    ]));
    const client = new ApiClient({
      baseUrl: '/api/v1/',
      token: 'secret-token',
      fetchImpl,
    });

    const page = await client.listCategories();

    expect(page.items).toHaveLength(1);
    expect(fetchImpl).toHaveBeenCalledOnce();
    const [url, init] = fetchImpl.mock.calls[0]!;
    expect(url).toBe('/api/v1/categories');
    expect(init?.credentials).toBe('same-origin');
    expect(new Headers(init?.headers).get('authorization')).toBe('Bearer secret-token');
  });

  it('exchanges an administrator token for a cookie session without bearer state', async () => {
    const fetchImpl = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(new Response(null, { status: 204 }))
      .mockResolvedValueOnce(jsonResponse({ items: [], nextCursor: null }));
    const client = new ApiClient({ fetchImpl });

    await client.createSession('one-time-secret');
    await client.verifySession();

    expect(fetchImpl.mock.calls[0]?.[0]).toBe('/api/v1/session');
    expect(fetchImpl.mock.calls[0]?.[1]).toEqual(expect.objectContaining({
      method: 'POST',
      credentials: 'same-origin',
      body: JSON.stringify({ token: 'one-time-secret' }),
    }));
    expect(fetchImpl.mock.calls[1]?.[0]).toBe('/api/v1/categories?limit=1');
    for (const [, init] of fetchImpl.mock.calls) {
      expect(new Headers(init?.headers).get('authorization')).toBeNull();
    }
  });

  it('follows every cursor when loading a complete choice collection', async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockImplementation(async (input) => {
      const url = new URL(String(input), 'http://review-engine.test');
      if (url.searchParams.get('cursor') === 'page-2') {
        return jsonResponse({ items: [{ id: 'cat-2', name: 'Tea' }], nextCursor: null });
      }
      return jsonResponse({ items: [{ id: 'cat-1', name: 'Coffee' }], nextCursor: 'page-2' });
    });
    const client = new ApiClient({ fetchImpl });

    const categories = await client.listAllCategories({ limit: 1 });

    expect(categories.map((category) => category.id)).toEqual(['cat-1', 'cat-2']);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(String(fetchImpl.mock.calls[1]?.[0])).toContain('cursor=page-2');
  });

  it('preserves machine-readable API errors', async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(jsonResponse(
      { code: 'TEMPLATE_IMMUTABLE', message: 'Published templates cannot be changed.' },
      { status: 409 },
    ));
    const client = new ApiClient({ fetchImpl });

    const error = await client.updateTemplateDraft('version-1', { criteria: [], revision: 0 }).catch((cause) => cause);

    expect(error).toBeInstanceOf(ApiError);
    expect(error).toMatchObject({ status: 409, code: 'TEMPLATE_IMMUTABLE' });
    expect((error as Error).message).toBe('Request failed (409)');
  });

  it('encodes comparison entity IDs as repeated public API parameters', async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(jsonResponse({
      categoryId: 'cat-1',
      aggregation: 'mean',
      entities: [],
    }));
    const client = new ApiClient({ fetchImpl });

    await client.compare({
      categoryId: 'cat-1',
      entityIds: ['one', 'two'],
      aggregation: 'mean',
    });

    expect(fetchImpl.mock.calls[0]?.[0]).toBe('/api/v1/comparisons?categoryId=cat-1&entityId=one&entityId=two&aggregation=mean');
  });

  it('requests hidden review history and sends visibility revisions', async () => {
    const fetchImpl = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(jsonResponse({ items: [], nextCursor: null }))
      .mockResolvedValueOnce(jsonResponse({
        id: 'review-1',
        entityId: 'entity-1',
        templateVersionId: 'template-1',
        reviewedAt: '2026-01-02T00:00:00Z',
        createdAt: '2026-01-02T00:00:00Z',
        status: 'final',
        hiddenAt: '2026-01-03T00:00:00Z',
        scores: [],
        revision: 5,
      }));
    const client = new ApiClient({ fetchImpl });

    await client.listReviews('entity-1', { includeSuperseded: true, includeHidden: true, limit: 50 });
    await client.updateReviewVisibility('review-1', { hidden: true, revision: 4 });

    expect(fetchImpl.mock.calls[0]?.[0]).toBe('/api/v1/entities/entity-1/reviews?includeSuperseded=true&includeHidden=true&limit=50');
    expect(fetchImpl.mock.calls[1]?.[0]).toBe('/api/v1/reviews/review-1/visibility');
    expect(fetchImpl.mock.calls[1]?.[1]).toEqual(expect.objectContaining({
      method: 'PATCH',
      body: JSON.stringify({ hidden: true, revision: 4 }),
    }));
  });

  it('uploads pictures sequentially as raw files and carries optimistic revisions', async () => {
    const review = {
      id: 'review-1',
      entityId: 'entity-1',
      templateVersionId: 'template-1',
      reviewedAt: '2026-01-02T00:00:00Z',
      createdAt: '2026-01-02T00:00:00Z',
      status: 'draft',
      pictures: [],
      scores: [],
      revision: 5,
    };
    const fetchImpl = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(jsonResponse({ ...review, revision: 5 }, { status: 201 }))
      .mockResolvedValueOnce(jsonResponse({ ...review, revision: 6 }, { status: 201 }))
      .mockResolvedValueOnce(jsonResponse({ ...review, revision: 7 }));
    const client = new ApiClient({ token: 'picture-token', fetchImpl });
    const first = new File(['first'], 'first.jpg', { type: 'image/jpeg' });
    const second = new File(['second'], 'label & back.png', { type: 'image/png' });

    const uploaded = await client.uploadReviewPictures('review-1', [first, second], 4);
    await client.deleteReviewPicture('review-1', 'picture-1', 5);

    expect(uploaded.revision).toBe(6);
    const [firstUrl, firstInit] = fetchImpl.mock.calls[0]!;
    expect(firstUrl).toBe('/api/v1/reviews/review-1/pictures?revision=4&fileName=first.jpg');
    expect(firstInit).toEqual(expect.objectContaining({
      method: 'POST',
      body: first,
      credentials: 'same-origin',
    }));
    expect(new Headers(firstInit?.headers)).toEqual(expect.objectContaining({}));
    expect(new Headers(firstInit?.headers).get('content-type')).toBe('image/jpeg');
    expect(new Headers(firstInit?.headers).get('authorization')).toBe('Bearer picture-token');

    const [secondUrl, secondInit] = fetchImpl.mock.calls[1]!;
    expect(secondUrl).toBe('/api/v1/reviews/review-1/pictures?revision=5&fileName=label+%26+back.png');
    expect(secondInit).toEqual(expect.objectContaining({
      method: 'POST',
      body: second,
      credentials: 'same-origin',
    }));
    expect(new Headers(secondInit?.headers).get('content-type')).toBe('image/png');
    expect(fetchImpl.mock.calls[2]?.[0]).toBe('/api/v1/reviews/review-1/pictures/picture-1?revision=5');
    expect(fetchImpl.mock.calls[2]?.[1]?.method).toBe('DELETE');
  });

  it('stops sequential picture uploads and preserves unauthorized handling', async () => {
    const onUnauthorized = vi.fn();
    const fetchImpl = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(jsonResponse({ revision: 8 }, { status: 201 }))
      .mockResolvedValueOnce(jsonResponse({ code: 'UNAUTHORIZED' }, { status: 401 }));
    const client = new ApiClient({ fetchImpl, onUnauthorized });
    const pictures = [
      new File(['one'], 'one.jpg', { type: 'image/jpeg' }),
      new File(['two'], 'two.jpg', { type: 'image/jpeg' }),
      new File(['three'], 'three.jpg', { type: 'image/jpeg' }),
    ];

    const error = await client.uploadReviewPictures('review-1', pictures, 7).catch((cause) => cause);

    expect(error).toMatchObject({ status: 401, code: 'UNAUTHORIZED' });
    expect(onUnauthorized).toHaveBeenCalledOnce();
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(fetchImpl.mock.calls[1]?.[0]).toBe('/api/v1/reviews/review-1/pictures?revision=8&fileName=two.jpg');
  });

  it('serializes template scale values as exact decimal strings', async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(jsonResponse({
      id: 'version-1', categoryId: 'cat-1', version: 1, status: 'draft', criteria: [],
    }));
    const client = new ApiClient({ fetchImpl });

    await client.createTemplateDraft('cat-1', [{
      id: 'criterion-1',
      name: 'Flavor',
      minValue: 0,
      maxValue: 7.5,
      stepValue: 0.5,
      position: 0,
      required: true,
    }]);

    const init = fetchImpl.mock.calls[0]?.[1];
    expect(JSON.parse(String(init?.body))).toMatchObject({
      criteria: [{ minValue: '0', maxValue: '7.5', stepValue: '0.5' }],
    });
  });
});
