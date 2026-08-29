export type ErrorDetails = Record<string, string>;

export class HttpError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly details: ErrorDetails = {},
  ) {
    super(message);
    this.name = 'HttpError';
  }
}

export function apiHeaders(headers?: HeadersInit): Headers {
  const result = new Headers(headers);
  result.set('Cache-Control', 'no-store');
  result.set('X-Content-Type-Options', 'nosniff');
  result.set('Referrer-Policy', 'same-origin');
  return result;
}

export function json(value: unknown, status = 200, headers?: HeadersInit): Response {
  const responseHeaders = apiHeaders(headers);
  responseHeaders.set('Content-Type', 'application/json; charset=utf-8');
  return new Response(JSON.stringify(value), { status, headers: responseHeaders });
}

export function noContent(headers?: HeadersInit): Response {
  return new Response(null, { status: 204, headers: apiHeaders(headers) });
}

export function problem(error: HttpError): Response {
  return json({ code: error.code, message: error.message, details: error.details }, error.status);
}

async function readLimitedBody(request: Request, maximumBytes: number): Promise<string> {
  const contentLength = request.headers.get('content-length');
  if (contentLength !== null) {
    const declared = Number(contentLength);
    if (Number.isFinite(declared) && declared > maximumBytes) {
      throw new HttpError(413, 'PAYLOAD_TOO_LARGE', `The request body must be at most ${maximumBytes} bytes`, {
        maximumBytes: String(maximumBytes),
      });
    }
  }
  if (!request.body) throw new HttpError(400, 'INVALID_ARGUMENT', 'The request body must contain valid JSON');
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maximumBytes) {
      await reader.cancel().catch(() => undefined);
      throw new HttpError(413, 'PAYLOAD_TOO_LARGE', `The request body must be at most ${maximumBytes} bytes`, {
        maximumBytes: String(maximumBytes),
      });
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
}

export async function parseJson<T>(request: Request, maximumBytes = 4_000_000): Promise<T> {
  const type = request.headers.get('content-type')?.toLowerCase() ?? '';
  if (!type.includes('application/json')) {
    throw new HttpError(400, 'INVALID_ARGUMENT', 'Content-Type must be application/json');
  }
  try {
    return JSON.parse(await readLimitedBody(request, maximumBytes)) as T;
  } catch (error) {
    if (error instanceof HttpError) throw error;
    throw new HttpError(400, 'INVALID_ARGUMENT', 'The request body must contain valid JSON');
  }
}

export function requireObject(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new HttpError(400, 'INVALID_ARGUMENT', 'The request body must be a JSON object');
  }
  return value as Record<string, unknown>;
}

export function requireString(value: unknown, field: string): string {
  if (typeof value !== 'string') {
    throw new HttpError(422, 'INVALID_ARGUMENT', `${field} must be a string`, { field });
  }
  return value;
}

export function requireNonBlank(value: unknown, field: string): string {
  const normalized = requireString(value, field).trim();
  if (!normalized) {
    throw new HttpError(422, 'INVALID_ARGUMENT', `${field} must not be blank`, { field });
  }
  return normalized;
}

export function optionalText(value: unknown, field: string): string | null {
  if (value === null || value === undefined) return null;
  const normalized = requireString(value, field).trim();
  return normalized || null;
}

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function requireUuid(value: unknown, field = 'id'): string {
  if (typeof value !== 'string' || !UUID_PATTERN.test(value)) {
    throw new HttpError(422, 'INVALID_ARGUMENT', 'Expected a UUID', { field, value: String(value ?? '') });
  }
  return value.toLowerCase();
}

export function requireInteger(value: unknown, field: string, minimum?: number): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || (minimum !== undefined && value < minimum)) {
    throw new HttpError(422, 'INVALID_ARGUMENT', `${field} must be an integer`, { field });
  }
  return value;
}

export function requireInstant(value: unknown, field: string): string {
  const text = requireString(value, field);
  if (!/^\d{4}-\d{2}-\d{2}T/.test(text) || !/(?:Z|[+-]\d{2}:\d{2})$/.test(text) || !Number.isFinite(Date.parse(text))) {
    throw new HttpError(422, 'INVALID_ARGUMENT', 'Expected an ISO 8601 timestamp', { field, value: text });
  }
  return text;
}

export function nowIso(): string {
  return new Date().toISOString();
}

export function mutationIso(): string {
  const base = new Date().toISOString();
  const entropy = crypto.getRandomValues(new Uint32Array(1))[0]! % 1_000_000;
  return base.replace(/Z$/, `${String(entropy).padStart(6, '0')}Z`);
}

export function decodeCursor(cursor: string | null): number {
  if (!cursor) return 0;
  try {
    const normalized = cursor.replace(/-/g, '+').replace(/_/g, '/');
    const offset = Number.parseInt(atob(normalized), 10);
    if (!Number.isSafeInteger(offset) || offset < 0 || String(offset) !== atob(normalized)) throw new Error();
    return offset;
  } catch {
    throw new HttpError(422, 'INVALID_ARGUMENT', 'Invalid pagination cursor');
  }
}

export function encodeCursor(offset: number): string {
  return btoa(String(offset)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export function normalizeLimit(raw: string | null): number {
  if (raw === null || raw === '') return 50;
  const value = Number(raw);
  if (!Number.isInteger(value)) throw new HttpError(422, 'INVALID_ARGUMENT', 'limit must be an integer');
  return Math.max(1, Math.min(100, value));
}

export function booleanQuery(url: URL, name: string, fallback = false): boolean {
  const raw = url.searchParams.get(name);
  if (raw === null) return fallback;
  if (raw === 'true') return true;
  if (raw === 'false') return false;
  throw new HttpError(422, 'INVALID_ARGUMENT', `${name} must be true or false`);
}

export function notFound(resource: string, id: string): never {
  throw new HttpError(404, 'NOT_FOUND', `${resource} was not found`, { resource, id });
}

export function conflict(message: string, details: ErrorDetails = {}): never {
  throw new HttpError(409, 'CONFLICT', message, details);
}

export function optimisticConflict(resource: string, id: string, expected: number, actual?: number): never {
  const details: ErrorDetails = { resource, id, expectedRevision: String(expected) };
  if (actual !== undefined) details.actualRevision = String(actual);
  throw new HttpError(409, 'OPTIMISTIC_LOCK_CONFLICT', `${resource} was modified by another request`, details);
}

export function isConstraintError(error: unknown): boolean {
  const text = error instanceof Error ? error.message : String(error);
  return /(?:UNIQUE|FOREIGN KEY|CHECK|constraint failed|SQLITE_CONSTRAINT)/i.test(text);
}
