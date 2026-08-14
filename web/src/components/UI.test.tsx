import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useState } from 'react';
import { Dialog } from './UI';

function DialogHarness() {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button type="button" onClick={() => setOpen(true)}>Open editor</button>
      <main id="main-content" tabIndex={-1}>Background content</main>
      <Dialog open={open} onClose={() => setOpen(false)} title="Edit item">
        <button type="button">First action</button>
        <input aria-label="Item name" />
        <button type="button">Last action</button>
      </Dialog>
    </>
  );
}

describe('Dialog', () => {
  it('traps keyboard focus and restores it to the opener', async () => {
    const user = userEvent.setup();
    render(<DialogHarness />);
    const opener = screen.getByRole('button', { name: 'Open editor' });

    await user.click(opener);
    const dialog = screen.getByRole('dialog', { name: 'Edit item' });
    const close = within(dialog).getByRole('button', { name: 'Close dialog' });
    await waitFor(() => expect(close).toHaveFocus());

    await user.tab({ shift: true });
    expect(within(dialog).getByRole('button', { name: 'Last action' })).toHaveFocus();
    await user.tab();
    expect(close).toHaveFocus();

    await user.keyboard('{Escape}');
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(opener).toHaveFocus();
  });
});
