import openApi from '../../backend/src/main/resources/openapi.json';
import { authenticate, createSession, deleteSession, isAdminTokenConfigured, requireSameOriginForCookieWrite } from './auth';
import { handleCategoryRoutes } from './categories';
import { handleComparisonRoutes } from './comparisons';
import { handleEntityRoutes } from './entities';
import { apiHeaders, HttpError, isConstraintError, json, problem } from './http';
import { handlePortabilityRoutes } from './portability';
import { handleRelationRoutes } from './relations';
import { drainR2DeletionOutbox, handleReviewRoutes } from './reviews';
import { handleTokenRoutes } from './tokens';

function buildOpenApiDocument(): unknown {
  const document = structuredClone(openApi) as unknown as Record<string, any>;
  document.info.version = '0.2.0';
  document.info.description = 'Authenticated REST API for Review Engine on Cloudflare Workers, D1, and R2. Health checks and this document are public.';
  const picturePath = document.paths['/reviews/{reviewId}/pictures'];
  picturePath.post.description = 'Attach one picture to a draft review. Send up to three sequential requests per review; each raw picture body must include Content-Length and can contain at most 100,000,000 bytes. JPEG, PNG, WebP, and GIF signatures are accepted. The review revision increments after each picture.';
  picturePath.post.parameters = [
    {
      name: 'revision', in: 'query', required: true,
      schema: { type: 'integer', format: 'int64', minimum: 0 },
      description: 'Current optimistic revision of the draft review.',
    },
    {
      name: 'fileName', in: 'query', required: true,
      schema: { type: 'string', minLength: 1, maxLength: 255 },
      description: 'Original display file name. R2 object keys are generated server-side.',
    },
  ];
  document.components.requestBodies.PictureUpload = {
    required: true,
    content: Object.fromEntries(
      ['image/jpeg', 'image/png', 'image/webp', 'image/gif'].map((contentType) => [
        contentType,
        { schema: { type: 'string', format: 'binary', maxLength: 100000000 } },
      ]),
    ),
  };
  document.paths['/exports'].post.description = 'Export portable structured review data. Picture metadata and R2 binary objects are intentionally excluded.';
  document.paths['/imports'].post.description = 'Import at most 450 portable rows into an empty database in one atomic D1 batch. Picture files and credentials are not imported.';
  document.paths['/imports/validate'].post.description = 'Validate a portable document containing at most 450 rows without writing it.';
  return document;
}

const apiDocument = buildOpenApiDocument();

async function api(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);
  if (url.pathname === '/openapi.json' || url.pathname === '/api/v1/openapi.json') {
    return json(apiDocument);
  }
  if (!url.pathname.startsWith('/api/v1/')) {
    throw new HttpError(404, 'NOT_FOUND', 'Resource was not found');
  }
  const path = url.pathname.slice('/api/v1/'.length).split('/').filter(Boolean).map(decodeURIComponent);
  const method = request.method.toUpperCase();

  if (path.length === 2 && path[0] === 'health' && path[1] === 'live' && method === 'GET') {
    return json({ status: 'ok' });
  }
  if (path.length === 2 && path[0] === 'health' && path[1] === 'ready' && method === 'GET') {
    if (!isAdminTokenConfigured(env)) return json({ status: 'unavailable' }, 503);
    try {
      const ready = await env.DB.prepare('SELECT 1 AS ready').first<number>('ready');
      return json({ status: ready === 1 ? 'ok' : 'unavailable' }, ready === 1 ? 200 : 503);
    } catch {
      return json({ status: 'unavailable' }, 503);
    }
  }
  if (path.length === 1 && path[0] === 'session' && method === 'POST') return createSession(request, env);
  if (path.length === 1 && path[0] === 'session' && method === 'DELETE') {
    const origin = request.headers.get('origin');
    if (origin && origin !== url.origin) throw new HttpError(403, 'ORIGIN_MISMATCH', 'The request origin does not match this application');
    return deleteSession(request, env);
  }

  const authentication = await authenticate(request, env);
  requireSameOriginForCookieWrite(request, authentication);
  const handlers = [
    handleCategoryRoutes,
    handleReviewRoutes,
    handleEntityRoutes,
    handleComparisonRoutes,
    handleRelationRoutes,
    handlePortabilityRoutes,
    handleTokenRoutes,
  ];
  for (const handler of handlers) {
    const response = await handler(request, env, path, method);
    if (response) return response;
  }
  throw new HttpError(404, 'NOT_FOUND', 'Resource was not found');
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const started = Date.now();
    const requestId = crypto.randomUUID();
    const url = new URL(request.url);
    const isApiRequest = url.pathname === '/openapi.json' || url.pathname.startsWith('/api/');
    let response: Response;
    try {
      if (isApiRequest) {
        response = await api(request, env);
      } else {
        response = await env.ASSETS.fetch(request);
      }
    } catch (error) {
      if (error instanceof HttpError) {
        response = problem(error);
      } else if (isConstraintError(error)) {
        response = problem(new HttpError(409, 'CONFLICT', 'The write conflicts with existing data'));
      } else {
        console.error(JSON.stringify({
          event: 'request_failed', requestId, method: request.method, path: url.pathname,
          error: error instanceof Error ? error.message : String(error),
        }));
        response = problem(new HttpError(500, 'INTERNAL_ERROR', 'The request could not be completed', { requestId }));
      }
    }
    const headers = isApiRequest ? apiHeaders(response.headers) : new Headers(response.headers);
    headers.set('X-Request-Id', requestId);
    console.log(JSON.stringify({
      event: 'request_complete', requestId, method: request.method, path: url.pathname,
      status: response.status, durationMs: Date.now() - started,
    }));
    return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
  },
  async scheduled(_controller: ScheduledController, env: Env, context: ExecutionContext): Promise<void> {
    context.waitUntil(drainR2DeletionOutbox(env));
  },
} satisfies ExportedHandler<Env>;
