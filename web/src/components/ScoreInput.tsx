import type { Criterion } from '../api/types';
import { criterionId, criterionTicks, formatScore, tickDisplay } from '../lib';
import { en } from '../messages';

export function ScoreInput({
  criterion,
  value,
  onChange,
  disabled = false,
}: {
  criterion: Criterion;
  value: number | undefined;
  onChange: (value: number | undefined) => void;
  disabled?: boolean;
}) {
  const maxTick = criterionTicks(criterion);
  const current = value === undefined ? '' : String(value);
  const display = value === undefined ? en.scoreInput.notScored : formatScore(tickDisplay(criterion, value));
  const id = `score-${criterionId(criterion)}`;

  return (
    <fieldset className="score-input" disabled={disabled}>
      <legend>
        <span>{criterion.name}</span>
        {criterion.required ? <span className="required-label">{en.common.required}</span> : <span className="optional-label">{en.common.optional}</span>}
      </legend>
      {criterion.description && <p>{criterion.description}</p>}
      <div className="score-control">
        <input
          id={id}
          type="range"
          min="0"
          max={maxTick}
          step="1"
          value={current || '0'}
          aria-label={en.scoreInput.scoreLabel(criterion.name)}
          aria-valuetext={display}
          onChange={(event) => onChange(Number(event.currentTarget.value))}
          onPointerDown={() => {
            if (value === undefined) onChange(0);
          }}
        />
        <output htmlFor={id} aria-live="polite">{display}</output>
      </div>
      <div className="score-scale" aria-hidden="true">
        <span>{formatScore(criterion.minValue)}</span>
        <span>{formatScore(criterion.maxValue)}</span>
      </div>
      {!criterion.required && value !== undefined && (
        <button type="button" className="text-button" onClick={() => onChange(undefined)}>{en.scoreInput.clearScore}</button>
      )}
    </fieldset>
  );
}
