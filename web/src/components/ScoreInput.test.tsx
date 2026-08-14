import { fireEvent, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { Criterion } from '../api/types';
import { ScoreInput } from './ScoreInput';

const criterion: Criterion = {
  id: 'flavor',
  name: 'Flavor',
  description: 'Balance, clarity, and finish',
  minValue: -1,
  maxValue: 1,
  stepValue: 0.5,
  position: 0,
  required: false,
};

describe('ScoreInput', () => {
  it('shows an unscored optional criterion accessibly', () => {
    render(<ScoreInput criterion={criterion} value={undefined} onChange={vi.fn()} />);

    expect(screen.getByRole('slider', { name: 'Flavor score' })).toHaveAttribute('aria-valuetext', 'Not scored');
    expect(screen.getByText('Optional')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /clear score/i })).not.toBeInTheDocument();
  });

  it('converts tick changes to exact display-scale values', () => {
    const onChange = vi.fn();
    const { rerender } = render(<ScoreInput criterion={criterion} value={undefined} onChange={onChange} />);
    const slider = screen.getByRole('slider', { name: 'Flavor score' });

    fireEvent.change(slider, { target: { value: '3' } });
    expect(onChange).toHaveBeenCalledWith(3);

    rerender(<ScoreInput criterion={criterion} value={3} onChange={onChange} />);
    expect(screen.getByText('0.5')).toBeInTheDocument();
    expect(slider).toHaveAttribute('aria-valuetext', '0.5');
  });

  it('lets a user clear an optional score', async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(<ScoreInput criterion={criterion} value={2} onChange={onChange} />);

    await user.click(screen.getByRole('button', { name: /clear score/i }));
    expect(onChange).toHaveBeenCalledWith(undefined);
  });
});
