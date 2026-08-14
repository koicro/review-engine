import type { Criterion } from './api/types';
import { ApiError } from './api/client';
import { en } from './messages';

export function formatDateTime(value?: string | null): string {
  if (!value) return en.common.notYet;
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return value;
  return new Intl.DateTimeFormat(undefined, {
    dateStyle: 'medium',
    timeStyle: 'short',
  }).format(parsed);
}

export function formatDate(value?: string | null): string {
  if (!value) return '—';
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return value;
  return new Intl.DateTimeFormat(undefined, { dateStyle: 'medium' }).format(parsed);
}

export function formatScore(value?: string | number | null): string {
  if (value === undefined || value === null) return '—';
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return String(value);
  return new Intl.NumberFormat(undefined, { maximumFractionDigits: 4 }).format(numeric);
}

export function toLocalDateTimeInput(value = new Date()): string {
  const local = new Date(value.getTime() - value.getTimezoneOffset() * 60_000);
  return local.toISOString().slice(0, 16);
}

export function inputDateTimeToIso(value: string): string {
  return new Date(value).toISOString();
}

export function criterionId(criterion: Criterion): string {
  return criterion.criterionId || criterion.id;
}

export function criterionTicks(criterion: Criterion): number {
  const min = Number(criterion.minValue);
  const max = Number(criterion.maxValue);
  const step = Number(criterion.stepValue);
  if (![min, max, step].every(Number.isFinite) || step <= 0) return 0;
  return Math.round((max - min) / step);
}

export function tickDisplay(criterion: Criterion, tick: number): number {
  const min = Number(criterion.minValue);
  const step = Number(criterion.stepValue);
  const value = min + step * tick;
  return Number(value.toFixed(10));
}

export function explainError(error: unknown): string {
  if (error instanceof ApiError) {
    const message = apiErrorMessages[error.code];
    if (message) return message;
    if (error.status === 401 || error.status === 403) {
      return en.errors.sessionExpired;
    }
    if (error.status === 404) {
      return en.errors.notFound;
    }
    if (error.status === 409) {
      return en.errors.conflict;
    }
    if (error.status >= 500) {
      return en.errors.server;
    }
    return en.errors.rejected;
  }
  if (error instanceof TypeError) {
    return en.errors.unreachable;
  }
  if (error instanceof Error) return error.message;
  return en.errors.unexpected;
}

const apiErrorMessages: Record<string, string> = en.errors.codes;
