# ADR 0002: Integer score storage

- Status: Accepted
- Date: 2026-08-13

## Context

Criteria can use decimal minimums, maximums, and steps. Persisting submitted floating-point values would make scale membership and cross-version comparison vulnerable to binary rounding errors.

## Decision

Persist each score as an integer `tick_index` relative to the criterion definition in the review's immutable template version.

```text
display_value = min_value + step_value * tick_index
max_tick      = (max_value - min_value) / step_value
normalized    = tick_index / max_tick
```

Keep scale metadata in a decimal-safe representation. API inputs use `tickIndex`; responses may include the tick, display value, and normalized value.

## Consequences

Scale validation and storage are exact. Display values are reconstructed from historical template metadata. Changing a criterion scale does not mutate prior scores, and comparison projections normalize values before aggregating across compatible template versions.
