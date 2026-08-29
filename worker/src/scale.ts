import Decimal from 'decimal.js';
import { HttpError, requireInteger } from './http';

Decimal.set({ precision: 40, rounding: Decimal.ROUND_HALF_EVEN, toExpNeg: -1e9, toExpPos: 1e9 });

function decimal(value: unknown, field: string): Decimal {
  if (typeof value !== 'string') {
    throw new HttpError(422, 'INVALID_DECIMAL', `${field} must be a decimal string`, { [field]: String(value ?? '') });
  }
  try {
    return new Decimal(value);
  } catch {
    throw new HttpError(422, 'INVALID_DECIMAL', `${field} must be a decimal string`, { [field]: value });
  }
}

function canonical(value: Decimal): string {
  const result = value.toFixed();
  if (!result.includes('.')) return result === '-0' ? '0' : result;
  const trimmed = result.replace(/(?:\.0+|(?:(\.\d*?)0+))$/, '$1');
  return trimmed === '-0' ? '0' : trimmed;
}

export class Scale {
  readonly min: Decimal;
  readonly max: Decimal;
  readonly step: Decimal;
  readonly maxTick: number;

  constructor(minValue: unknown, maxValue: unknown, stepValue: unknown) {
    this.min = decimal(minValue, 'minValue');
    this.max = decimal(maxValue, 'maxValue');
    this.step = decimal(stepValue, 'stepValue');
    if (!this.min.lt(this.max)) {
      throw new HttpError(422, 'INVALID_SCALE', 'Scale minimum must be less than its maximum');
    }
    if (!this.step.gt(0)) {
      throw new HttpError(422, 'INVALID_SCALE', 'Scale step must be greater than zero');
    }
    const ticks = this.max.minus(this.min).div(this.step);
    if (!ticks.isInteger() || ticks.lt(0) || ticks.gt(Number.MAX_SAFE_INTEGER)) {
      throw new HttpError(422, 'INVALID_SCALE', ticks.isInteger() ? 'Scale contains too many ticks' : 'Scale range must be exactly divisible by its step');
    }
    this.maxTick = ticks.toNumber();
  }

  requireTick(value: unknown): number {
    const tick = requireInteger(value, 'tickIndex', 0);
    if (tick > this.maxTick) {
      throw new HttpError(422, 'INVALID_TICK_INDEX', 'Tick index is outside the scale', {
        tickIndex: String(tick), minTick: '0', maxTick: String(this.maxTick),
      });
    }
    return tick;
  }

  display(tick: number): string {
    return canonical(this.min.plus(this.step.times(tick)));
  }

  normalized(tick: number): number {
    return new Decimal(tick).div(this.maxTick).toNumber();
  }

  minValue(): string { return canonical(this.min); }
  maxValue(): string { return canonical(this.max); }
  stepValue(): string { return canonical(this.step); }
}
