import { HttpError, isConstraintError, notFound } from './http';

export type DbRow = Record<string, unknown>;

export async function all<T extends DbRow>(statement: D1PreparedStatement): Promise<T[]> {
  const result = await statement.all<T>();
  return result.results;
}

export async function maybeOne<T extends DbRow>(statement: D1PreparedStatement): Promise<T | null> {
  return await statement.first<T>();
}

export async function one<T extends DbRow>(statement: D1PreparedStatement, resource: string, id: string): Promise<T> {
  const row = await maybeOne<T>(statement);
  if (!row) notFound(resource, id);
  return row;
}

export async function run(statement: D1PreparedStatement): Promise<D1Result> {
  try {
    return await statement.run();
  } catch (error) {
    if (isConstraintError(error)) {
      throw new HttpError(409, 'CONFLICT', 'The write conflicts with existing data');
    }
    throw error;
  }
}

export async function batch(database: D1Database, statements: D1PreparedStatement[]): Promise<D1Result[]> {
  try {
    return await database.batch(statements);
  } catch (error) {
    if (isConstraintError(error)) {
      throw new HttpError(409, 'CONFLICT', 'The write conflicts with existing data');
    }
    throw error;
  }
}

export function changed(result: D1Result): number {
  return Number(result.meta.changes ?? 0);
}

export function asNumber(value: unknown): number {
  return typeof value === 'number' ? value : Number(value);
}

export function asBoolean(value: unknown): boolean {
  return asNumber(value) !== 0;
}
