import { batch, maybeOne } from './db';
import { apiHeaders, HttpError, noContent, parseJson, requireNonBlank } from './http';

const SESSION_COOKIE = 'review_engine_session';
const SESSION_PATH = '/api/v1';
const SESSION_SECONDS = 12 * 60 * 60;
const MIN_ADMIN_TOKEN_LENGTH = 32;
const MAX_SESSION_REQUEST_BYTES = 8_192;

type IdentityKind = 'admin' | 'access_token';

interface SessionRow extends Record<string, unknown> {
  identity_kind: IdentityKind;
  credential_hash: string;
}

export async function sha256(value: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

function constantTimeTextEqual(left: string, right: string): boolean {
  const encoder = new TextEncoder();
  const subtle = crypto.subtle as SubtleCrypto & {
    timingSafeEqual(a: ArrayBuffer | ArrayBufferView, b: ArrayBuffer | ArrayBufferView): boolean;
  };
  return subtle.timingSafeEqual(encoder.encode(left), encoder.encode(right));
}

export function isAdminTokenConfigured(env: Env): boolean {
  return typeof env.REVIEW_ADMIN_TOKEN === 'string' && env.REVIEW_ADMIN_TOKEN.length >= MIN_ADMIN_TOKEN_LENGTH;
}

function configuredAdminToken(env: Env): string {
  if (!isAdminTokenConfigured(env)) {
    throw new HttpError(503, 'CONFIGURATION_ERROR', 'The administrator credential is not configured');
  }
  return env.REVIEW_ADMIN_TOKEN;
}

function randomSecret(prefix: string): string {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return `${prefix}${btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')}`;
}

export function newAccessToken(): string {
  return randomSecret('re_');
}

function cookieValue(request: Request, name: string): string | null {
  const cookies = request.headers.get('cookie');
  if (!cookies) return null;
  for (const part of cookies.split(';')) {
    const [rawName, ...rawValue] = part.trim().split('=');
    if (rawName === name) return decodeURIComponent(rawValue.join('='));
  }
  return null;
}

async function credentialIdentity(token: string, env: Env): Promise<{ kind: IdentityKind; hash: string } | null> {
  const hash = await sha256(token);
  const adminHash = await sha256(configuredAdminToken(env));
  if (constantTimeTextEqual(hash, adminHash)) return { kind: 'admin', hash };
  const active = await maybeOne<{ id: string } & Record<string, unknown>>(
    env.DB.prepare('SELECT id FROM access_token WHERE token_hash = ? AND revoked_at IS NULL').bind(hash),
  );
  return active ? { kind: 'access_token', hash } : null;
}

async function activeSession(rawId: string, env: Env): Promise<boolean> {
  const sessionHash = await sha256(rawId);
  const session = await maybeOne<SessionRow>(env.DB.prepare(
    `SELECT identity_kind, credential_hash FROM web_session
     WHERE session_hash = ? AND revoked_at IS NULL AND expires_at > ?`,
  ).bind(sessionHash, new Date().toISOString()));
  if (!session) return false;
  if (session.identity_kind === 'admin') {
    const adminHash = await sha256(configuredAdminToken(env));
    return constantTimeTextEqual(session.credential_hash, adminHash);
  }
  const active = await maybeOne<{ id: string } & Record<string, unknown>>(
    env.DB.prepare('SELECT id FROM access_token WHERE token_hash = ? AND revoked_at IS NULL').bind(session.credential_hash),
  );
  return active !== null;
}

export async function authenticate(request: Request, env: Env): Promise<'authorization' | 'cookie'> {
  const authorization = request.headers.get('authorization');
  if (authorization) {
    const match = /^Bearer\s+(.+)$/i.exec(authorization);
    if (match && await credentialIdentity(match[1]!, env)) return 'authorization';
    throw new HttpError(401, 'UNAUTHORIZED', 'Authentication is required');
  }
  const session = cookieValue(request, SESSION_COOKIE);
  if (session && await activeSession(session, env)) return 'cookie';
  throw new HttpError(401, 'UNAUTHORIZED', 'Authentication is required');
}

export function requireSameOriginForCookieWrite(request: Request, authentication: 'authorization' | 'cookie'): void {
  if (authentication !== 'cookie' || ['GET', 'HEAD', 'OPTIONS'].includes(request.method)) return;
  const origin = request.headers.get('origin');
  if (!origin || origin !== new URL(request.url).origin) {
    throw new HttpError(403, 'ORIGIN_MISMATCH', 'The request origin does not match this application');
  }
}

export async function createSession(request: Request, env: Env): Promise<Response> {
  const body = await parseJson<{ token?: unknown }>(request, MAX_SESSION_REQUEST_BYTES);
  const token = requireNonBlank(body?.token, 'token');
  if (token.length > 512) throw new HttpError(422, 'INVALID_ARGUMENT', 'token is too long');
  const identity = await credentialIdentity(token, env);
  if (!identity) throw new HttpError(401, 'UNAUTHORIZED', 'The supplied credential is not active');

  const rawId = randomSecret('res_');
  const sessionHash = await sha256(rawId);
  const createdAt = new Date();
  const expiresAt = new Date(createdAt.getTime() + SESSION_SECONDS * 1000);
  await batch(env.DB, [
    env.DB.prepare(
      `DELETE FROM web_session WHERE session_hash IN (
         SELECT session_hash FROM web_session
         WHERE expires_at <= ? OR revoked_at IS NOT NULL
         ORDER BY expires_at LIMIT 100
       )`,
    ).bind(createdAt.toISOString()),
    env.DB.prepare(
      `INSERT INTO web_session(session_hash, identity_kind, credential_hash, created_at, expires_at, revoked_at)
       VALUES (?, ?, ?, ?, ?, NULL)`,
    ).bind(sessionHash, identity.kind, identity.hash, createdAt.toISOString(), expiresAt.toISOString()),
  ]);

  const cookie = `${SESSION_COOKIE}=${encodeURIComponent(rawId)}; Path=${SESSION_PATH}; Max-Age=${SESSION_SECONDS}; Expires=${expiresAt.toUTCString()}; HttpOnly; Secure; SameSite=Strict`;
  return noContent({ 'Set-Cookie': cookie });
}

export async function deleteSession(request: Request, env: Env): Promise<Response> {
  const rawId = cookieValue(request, SESSION_COOKIE);
  if (rawId) {
    await env.DB.prepare(
      'UPDATE web_session SET revoked_at = ? WHERE session_hash = ? AND revoked_at IS NULL',
    ).bind(new Date().toISOString(), await sha256(rawId)).run();
  }
  const headers = apiHeaders({
    'Set-Cookie': `${SESSION_COOKIE}=; Path=${SESSION_PATH}; Max-Age=0; Expires=Thu, 01 Jan 1970 00:00:00 GMT; HttpOnly; Secure; SameSite=Strict`,
  });
  return new Response(null, { status: 204, headers });
}
