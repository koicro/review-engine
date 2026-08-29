import { all, changed, one, run } from './db';
import { newAccessToken, sha256 } from './auth';
import { json, nowIso, parseJson, requireNonBlank, requireObject, requireUuid } from './http';

interface TokenRow extends Record<string, unknown> {
  id: string;
  name: string;
  created_at: string;
  revoked_at: string | null;
}

function tokenDto(row: TokenRow): Record<string, unknown> {
  return { id: row.id, name: row.name, createdAt: row.created_at, revokedAt: row.revoked_at };
}

async function getToken(database: D1Database, id: string): Promise<TokenRow> {
  return one<TokenRow>(
    database.prepare('SELECT id, name, created_at, revoked_at FROM access_token WHERE id = ?').bind(id),
    'Access token', id,
  );
}

export async function handleTokenRoutes(
  request: Request,
  env: Env,
  path: string[],
  method: string,
): Promise<Response | null> {
  if (path[0] !== 'access-tokens') return null;
  if (path.length === 1 && method === 'GET') {
    const rows = await all<TokenRow>(env.DB.prepare(
      'SELECT id, name, created_at, revoked_at FROM access_token ORDER BY created_at DESC, id DESC',
    ));
    return json({ items: rows.map(tokenDto) });
  }
  if (path.length === 1 && method === 'POST') {
    const body = requireObject(await parseJson<unknown>(request));
    const secret = newAccessToken();
    const row: TokenRow = {
      id: crypto.randomUUID(),
      name: requireNonBlank(body.name, 'name'),
      created_at: nowIso(),
      revoked_at: null,
    };
    await run(env.DB.prepare(
      'INSERT INTO access_token(id, name, token_hash, created_at, revoked_at) VALUES (?, ?, ?, ?, NULL)',
    ).bind(row.id, row.name, await sha256(secret), row.created_at));
    return json({ token: tokenDto(row), secret }, 201);
  }
  if (path.length === 3 && path[2] === 'revoke' && method === 'POST') {
    const id = requireUuid(path[1], 'tokenId');
    const current = await getToken(env.DB, id);
    if (!current.revoked_at) {
      const revokedAt = nowIso();
      const result = await env.DB.prepare(
        'UPDATE access_token SET revoked_at = ? WHERE id = ? AND revoked_at IS NULL',
      ).bind(revokedAt, id).run();
      if (changed(result) === 1) current.revoked_at = revokedAt;
      else return json(tokenDto(await getToken(env.DB, id)));
    }
    return json(tokenDto(current));
  }
  return null;
}
