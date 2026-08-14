import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { ApiProvider } from './api/context';
import App from './App';

function json(body: unknown) {
  return Promise.resolve(new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  }));
}

describe('reference UI shell', () => {
  beforeEach(() => {
    window.location.hash = '#/overview';
    window.localStorage.clear();
    window.sessionStorage.clear();
    vi.stubGlobal('fetch', vi.fn((input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes('/categories')) return json({ items: [], nextCursor: null });
      if (url.includes('/entities')) return json({ items: [], nextCursor: null });
      if (url.includes('/access-tokens')) return json({ items: [], nextCursor: null });
      return json({});
    }));
  });

  afterEach(() => vi.unstubAllGlobals());

  it('guides an empty installation into category setup', async () => {
    render(<ApiProvider><App /></ApiProvider>);

    expect(await screen.findByRole('heading', { name: /notice what changes/i })).toBeInTheDocument();
    expect(await screen.findByRole('heading', { name: /design one useful scorecard/i })).toBeInTheDocument();
  });

  it('navigates between SPA workspaces without a router dependency', async () => {
    const user = userEvent.setup();
    render(<ApiProvider><App /></ApiProvider>);

    await screen.findByRole('heading', { name: /design one useful scorecard/i });
    const primaryNavigation = screen.getByRole('navigation', { name: 'Primary navigation' });
    await user.click(within(primaryNavigation).getByRole('link', { name: 'Categories' }));
    expect(await screen.findByRole('heading', { name: /categories & templates/i })).toBeInTheDocument();
    expect(window.location.hash).toBe('#/categories');
  });

  it('updates the hash when a page action navigates programmatically', async () => {
    const user = userEvent.setup();
    render(<ApiProvider><App /></ApiProvider>);

    await user.click(await screen.findByRole('button', { name: /set up a category/i }));

    expect(await screen.findByRole('heading', { name: /categories & templates/i })).toBeInTheDocument();
    expect(window.location.hash).toBe('#/categories');
  });

  it('moves focus to main content without changing the route', async () => {
    const user = userEvent.setup();
    render(<ApiProvider><App /></ApiProvider>);
    await screen.findByRole('heading', { name: /notice what changes/i });

    await user.click(screen.getByRole('link', { name: /skip to content/i }));

    expect(document.getElementById('main-content')).toHaveFocus();
    expect(window.location.hash).toBe('#/overview');
  });

  it('opens connection settings when no browser session is present', async () => {
    vi.mocked(fetch).mockResolvedValue(new Response(JSON.stringify({ code: 'UNAUTHORIZED', message: 'server detail' }), {
      status: 401,
      headers: { 'content-type': 'application/json' },
    }));
    render(<ApiProvider><App /></ApiProvider>);

    expect(await screen.findByRole('heading', { name: /settings/i })).toBeInTheDocument();
    expect(window.location.hash).toBe('#/settings');
    expect(fetch).toHaveBeenCalledWith('/api/v1/categories?limit=1', expect.objectContaining({ credentials: 'same-origin' }));
    expect(window.sessionStorage.getItem('review-engine.admin-token')).toBeNull();
  });

  it('exchanges the administrator token once and keeps later requests cookie-only', async () => {
    const user = userEvent.setup();
    let hasSession = false;
    vi.mocked(fetch).mockImplementation((input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith('/session') && init?.method === 'POST') {
        hasSession = true;
        return Promise.resolve(new Response(null, { status: 204 }));
      }
      if (url.includes('/categories') && !hasSession) {
        return Promise.resolve(new Response(JSON.stringify({ code: 'UNAUTHORIZED', message: 'do not display this' }), { status: 401 }));
      }
      if (url.includes('/categories')) return json({ items: [], nextCursor: null });
      if (url.includes('/access-tokens')) return json({ items: [], nextCursor: null });
      return json({});
    });
    render(<ApiProvider><App /></ApiProvider>);

    await user.type(await screen.findByLabelText(/Administrator token/i), 'one-time-secret');
    await user.click(screen.getByRole('button', { name: /start secure session/i }));

    expect(await screen.findByText(/administrator token was discarded/i)).toBeInTheDocument();
    const post = vi.mocked(fetch).mock.calls.find(([, init]) => init?.method === 'POST');
    expect(post?.[0]).toBe('/api/v1/session');
    expect(post?.[1]).toEqual(expect.objectContaining({ credentials: 'same-origin', body: JSON.stringify({ token: 'one-time-secret' }) }));
    const postHeaders = new Headers(post?.[1]?.headers);
    expect(postHeaders.get('authorization')).toBeNull();
    expect(screen.queryByDisplayValue('one-time-secret')).not.toBeInTheDocument();
    expect(window.sessionStorage.getItem('review-engine.admin-token')).toBeNull();

    for (const [, init] of vi.mocked(fetch).mock.calls.slice(1)) {
      expect(new Headers(init?.headers).get('authorization')).toBeNull();
    }
  });

  it('deletes the cookie session on logout and returns to setup', async () => {
    const user = userEvent.setup();
    render(<ApiProvider><App /></ApiProvider>);

    await screen.findByRole('heading', { name: /notice what changes/i });
    await user.click(screen.getByRole('link', { name: 'Settings' }));
    await user.click(await screen.findByRole('button', { name: 'Sign out' }));

    expect(fetch).toHaveBeenCalledWith('/api/v1/session', expect.objectContaining({ method: 'DELETE', credentials: 'same-origin' }));
    expect(await screen.findByRole('button', { name: /start secure session/i })).toBeInTheDocument();
  });
});
