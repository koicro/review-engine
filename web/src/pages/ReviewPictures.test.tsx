import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { ApiProvider } from '../api/context';
import type { Review, ReviewPicture, TemplateVersion } from '../api/types';
import { EntitiesPage, MAX_REVIEW_PICTURE_BYTES } from './EntitiesPage';

function json(body: unknown, init: ResponseInit = {}) {
  return Promise.resolve(new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'content-type': 'application/json' },
    ...init,
  }));
}

const template: TemplateVersion = {
  id: 'template-1',
  categoryId: 'category-1',
  version: 1,
  status: 'published',
  criteria: [],
  revision: 1,
};

const category = {
  id: 'category-1',
  name: 'Coffee',
  activeTemplateVersionId: template.id,
  activeTemplateVersion: template,
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
  reviewCount: 0,
  revision: 0,
};

function picture(id: string, fileName = `${id}.jpg`): ReviewPicture {
  return {
    id,
    fileName,
    contentType: 'image/jpeg',
    sizeBytes: 1_250_000,
    url: `/api/v1/reviews/review-1/pictures/${id}`,
    createdAt: '2026-01-02T00:00:00Z',
  };
}

function review(status: Review['status'], pictures: ReviewPicture[] = [], revision = 1): Review {
  return {
    id: 'review-1',
    entityId: entity.id,
    templateVersionId: template.id,
    templateVersion: { id: template.id, version: 1 },
    reviewedAt: '2026-01-02T00:00:00Z',
    createdAt: '2026-01-02T00:00:00Z',
    status,
    pictures,
    scores: [],
    revision,
  };
}

function baseResponse(url: URL, reviews: Review[] = []) {
  if (url.pathname.endsWith('/categories')) return json({ items: [category], nextCursor: null });
  if (url.pathname.endsWith('/entities')) return json({ items: [entity], nextCursor: null });
  if (url.pathname.endsWith('/entities/entity-1/reviews')) return json({ items: reviews, nextCursor: null });
  return null;
}

describe('review pictures', () => {
  beforeEach(() => {
    Object.defineProperty(URL, 'createObjectURL', {
      configurable: true,
      value: vi.fn((file: File) => `blob:${file.name}`),
    });
    Object.defineProperty(URL, 'revokeObjectURL', {
      configurable: true,
      value: vi.fn(),
    });
  });

  afterEach(() => {
    Reflect.deleteProperty(URL, 'createObjectURL');
    Reflect.deleteProperty(URL, 'revokeObjectURL');
    window.localStorage.clear();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it('saves selected pictures to a draft before finalizing it', async () => {
    const writes: Array<{ path: string; body?: BodyInit | null }> = [];
    let listedReviews: Review[] = [];
    const draft = review('draft', [], 1);
    const uploaded = review('draft', [picture('picture-1', 'front.jpg'), picture('picture-2', 'label.png')], 2);
    const finalized = review('final', uploaded.pictures, 3);

    vi.stubGlobal('fetch', vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(String(input), 'http://review-engine.test');
      if (url.pathname.endsWith('/entities/entity-1/reviews') && init?.method === 'POST') {
        writes.push({ path: url.pathname, body: init.body });
        return json(draft, { status: 201 });
      }
      if (url.pathname.endsWith('/reviews/review-1/pictures') && init?.method === 'POST') {
        writes.push({ path: url.pathname, body: init.body });
        return json(uploaded, { status: 201 });
      }
      if (url.pathname.endsWith('/reviews/review-1/finalize') && init?.method === 'POST') {
        writes.push({ path: url.pathname, body: init.body });
        listedReviews = [finalized];
        return json(finalized);
      }
      return baseResponse(url, listedReviews) ?? json({});
    }));
    const user = userEvent.setup();
    render(<ApiProvider><EntitiesPage /></ApiProvider>);

    await user.click(await screen.findByRole('button', { name: 'Record review' }));
    const input = screen.getByLabelText('Choose pictures');
    const first = new File(['front'], 'front.jpg', { type: 'image/jpeg' });
    const second = new File(['label'], 'label.png', { type: 'image/png' });
    await user.upload(input, [first, second]);

    expect(screen.getByText('2 of 3 attached')).toBeInTheDocument();
    expect(screen.getByText('front.jpg')).toBeInTheDocument();
    expect(screen.getByText('label.png')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Finalize review' }));

    expect(await screen.findByText('Review added to the timeline.')).toBeInTheDocument();
    expect(writes.map((write) => write.path)).toEqual([
      '/api/v1/entities/entity-1/reviews',
      '/api/v1/reviews/review-1/pictures',
      '/api/v1/reviews/review-1/finalize',
    ]);
    expect(JSON.parse(String(writes[0]?.body))).toMatchObject({ finalize: false });
    const form = writes[1]?.body as FormData;
    expect(form.get('revision')).toBe('1');
    expect((form.getAll('pictures') as File[]).map((file) => file.name)).toEqual(['front.jpg', 'label.png']);
    expect(JSON.parse(String(writes[2]?.body))).toMatchObject({ revision: 2 });
    expect(await screen.findByRole('link', { name: 'Open front.jpg' })).toBeInTheDocument();
  });

  it('enforces supported formats, the decimal 100 MB limit, and the three-picture limit before upload', async () => {
    vi.stubGlobal('fetch', vi.fn((input: RequestInfo | URL) => {
      const url = new URL(String(input), 'http://review-engine.test');
      return baseResponse(url) ?? json({});
    }));
    const user = userEvent.setup();
    render(<ApiProvider><EntitiesPage /></ApiProvider>);

    await user.click(await screen.findByRole('button', { name: 'Record review' }));
    const input = screen.getByLabelText('Choose pictures') as HTMLInputElement;
    fireEvent.change(input, { target: { files: [new File([], 'empty.jpg', { type: 'image/jpeg' })] } });
    expect(await screen.findByRole('alert')).toHaveTextContent('is empty');

    fireEvent.change(input, { target: { files: [new File(['notes'], 'notes.txt', { type: 'text/plain' })] } });
    expect(await screen.findByRole('alert')).toHaveTextContent('not a supported picture');

    const oversized = new File(['large'], 'large.jpg', { type: 'image/jpeg' });
    Object.defineProperty(oversized, 'size', { value: MAX_REVIEW_PICTURE_BYTES + 1 });
    fireEvent.change(input, { target: { files: [oversized] } });
    expect(await screen.findByRole('alert')).toHaveTextContent('larger than 100 MB');

    const boundary = new File(['boundary'], 'boundary.jpg', { type: 'image/jpeg' });
    Object.defineProperty(boundary, 'size', { value: MAX_REVIEW_PICTURE_BYTES });
    const second = new File(['second'], 'second.png', { type: 'image/png' });
    const third = new File(['third'], 'third.webp', { type: 'image/webp' });
    const fourth = new File(['fourth'], 'fourth.gif', { type: 'image/gif' });
    fireEvent.change(input, { target: { files: [boundary, second, third, fourth] } });

    expect(await screen.findByText('3 of 3 attached')).toBeInTheDocument();
    expect(screen.getByText('boundary.jpg')).toBeInTheDocument();
    expect(screen.queryByText('fourth.gif')).not.toBeInTheDocument();
    expect(screen.getByRole('alert')).toHaveTextContent('up to 3 pictures');
    expect(input).toBeDisabled();

    await user.click(screen.getByRole('button', { name: 'Remove second.png' }));
    expect(screen.getByText('2 of 3 attached')).toBeInTheDocument();
    expect(screen.getByLabelText('Choose pictures')).toBeEnabled();
  });

  it('refreshes the timeline when an upload failure leaves behind a recoverable draft', async () => {
    let persistedDraft: Review | null = null;
    let reviewReads = 0;
    vi.stubGlobal('fetch', vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(String(input), 'http://review-engine.test');
      if (url.pathname.endsWith('/entities/entity-1/reviews') && init?.method === 'POST') {
        persistedDraft = review('draft', [], 1);
        return json(persistedDraft, { status: 201 });
      }
      if (url.pathname.endsWith('/reviews/review-1/pictures') && init?.method === 'POST') {
        return json({ code: 'INVALID_ARGUMENT' }, { status: 400 });
      }
      if (url.pathname.endsWith('/entities/entity-1/reviews')) {
        reviewReads += 1;
        return json({ items: persistedDraft ? [persistedDraft] : [], nextCursor: null });
      }
      return baseResponse(url) ?? json({});
    }));
    const user = userEvent.setup();
    render(<ApiProvider><EntitiesPage /></ApiProvider>);

    await user.click(await screen.findByRole('button', { name: 'Record review' }));
    await user.upload(screen.getByLabelText('Choose pictures'), new File(['photo'], 'photo.jpg', { type: 'image/jpeg' }));
    await user.click(screen.getByRole('button', { name: 'Finalize review' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Check the entered values');

    await user.click(screen.getByRole('button', { name: 'Cancel' }));

    expect(await screen.findByRole('button', { name: 'Continue draft' })).toBeInTheDocument();
    expect(reviewReads).toBeGreaterThanOrEqual(2);
  });

  it('keeps every dialog close path locked while a picture upload is running', async () => {
    let resolveUpload!: (response: Response) => void;
    const uploadResponse = new Promise<Response>((resolve) => { resolveUpload = resolve; });
    let uploadStarted = false;
    const draft = review('draft', [], 1);
    const uploaded = review('draft', [picture('picture-1', 'photo.jpg')], 2);
    const finalized = review('final', uploaded.pictures, 3);
    vi.stubGlobal('fetch', vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(String(input), 'http://review-engine.test');
      if (url.pathname.endsWith('/entities/entity-1/reviews') && init?.method === 'POST') return json(draft, { status: 201 });
      if (url.pathname.endsWith('/reviews/review-1/pictures') && init?.method === 'POST') {
        uploadStarted = true;
        return uploadResponse;
      }
      if (url.pathname.endsWith('/reviews/review-1/finalize') && init?.method === 'POST') return json(finalized);
      return baseResponse(url) ?? json({});
    }));
    const user = userEvent.setup();
    render(<ApiProvider><EntitiesPage /></ApiProvider>);

    await user.click(await screen.findByRole('button', { name: 'Record review' }));
    await user.upload(screen.getByLabelText('Choose pictures'), new File(['photo'], 'photo.jpg', { type: 'image/jpeg' }));
    await user.click(screen.getByRole('button', { name: 'Finalize review' }));
    await waitFor(() => expect(uploadStarted).toBe(true));

    const dialog = screen.getByRole('dialog');
    expect(dialog.querySelector('form')).toHaveAttribute('aria-busy', 'true');
    expect(within(dialog).getByLabelText(/Observed at/)).toBeDisabled();
    expect(within(dialog).getByRole('button', { name: 'Cancel' })).toBeDisabled();
    expect(within(dialog).getByRole('button', { name: 'Close dialog' })).toBeDisabled();
    await user.keyboard('{Escape}');
    expect(screen.getByRole('dialog')).toBeInTheDocument();
    fireEvent.mouseDown(document.querySelector('.dialog-backdrop')!);
    expect(screen.getByRole('dialog')).toBeInTheDocument();

    resolveUpload(await json(uploaded, { status: 201 }));
    expect(await screen.findByText('Review added to the timeline.')).toBeInTheDocument();
  });

  it('uses the configured API origin for persisted picture links and editor previews', async () => {
    window.localStorage.setItem('review-engine.api-base', 'https://pictures.example.test/custom/v1');
    const persisted = review('draft', [picture('receipt', 'receipt.jpg')], 4);
    vi.stubGlobal('fetch', vi.fn((input: RequestInfo | URL) => {
      const url = new URL(String(input), 'http://review-engine.test');
      return baseResponse(url, [persisted]) ?? json({});
    }));
    const user = userEvent.setup();
    render(<ApiProvider><EntitiesPage /></ApiProvider>);

    const timelineLink = await screen.findByRole('link', { name: 'Open receipt.jpg' });
    expect(timelineLink).toHaveAttribute('href', 'https://pictures.example.test/custom/v1/reviews/review-1/pictures/receipt');
    const draftArticle = (await screen.findByText('draft')).closest('article')!;
    await user.click(within(draftArticle).getByRole('button', { name: 'Continue draft' }));

    const editor = screen.getByRole('dialog');
    const editorLink = within(editor).getByRole('link', { name: 'Open receipt.jpg' });
    expect(editorLink).toHaveAttribute('href', 'https://pictures.example.test/custom/v1/reviews/review-1/pictures/receipt');
    expect(within(editor).getByRole('img', { name: 'receipt.jpg' })).toHaveAttribute('loading', 'lazy');
  });

  it('removes persisted draft pictures with the latest review revision and keeps correction pictures read-only', async () => {
    let listedReviews = [review('draft', [picture('receipt', 'receipt.jpg')], 4)];
    let deleteRevision = '';
    vi.stubGlobal('fetch', vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(String(input), 'http://review-engine.test');
      if (url.pathname.endsWith('/reviews/review-1') && init?.method === 'PATCH') {
        return json(review('draft', [picture('receipt', 'receipt.jpg')], 5));
      }
      if (url.pathname.endsWith('/reviews/review-1/pictures/receipt') && init?.method === 'DELETE') {
        deleteRevision = url.searchParams.get('revision') ?? '';
        listedReviews = [review('draft', [], 6)];
        return json(listedReviews[0]);
      }
      return baseResponse(url, listedReviews) ?? json({});
    }));
    const user = userEvent.setup();
    const view = render(<ApiProvider><EntitiesPage /></ApiProvider>);

    const draftArticle = (await screen.findByText('draft')).closest('article')!;
    await user.click(within(draftArticle).getByRole('button', { name: 'Continue draft' }));
    await user.click(screen.getByRole('button', { name: 'Remove receipt.jpg' }));
    await user.click(screen.getByRole('button', { name: 'Save draft' }));

    expect(await screen.findByText('Draft saved.')).toBeInTheDocument();
    expect(deleteRevision).toBe('5');

    listedReviews = [review('final', [picture('receipt', 'receipt.jpg')], 7)];
    view.unmount();
    render(<ApiProvider><EntitiesPage /></ApiProvider>);
    const finalArticle = (await screen.findByText('final')).closest('article')!;
    await user.click(within(finalArticle).getByRole('button', { name: 'Correct this review' }));

    expect(screen.getByText('Pictures from the original review will be retained in this correction.')).toBeInTheDocument();
    expect(screen.queryByLabelText('Choose pictures')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Remove receipt.jpg' })).not.toBeInTheDocument();
  });
});
