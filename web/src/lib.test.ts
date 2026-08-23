import { ApiError } from './api/client';
import { explainError } from './lib';

describe('explainError', () => {
  it('maps stable API codes to recovery guidance without exposing server text', () => {
    const error = new ApiError(409, {
      code: 'OPTIMISTIC_LOCK_CONFLICT',
      message: 'Internal record lock_version mismatch for table review',
    });

    const explanation = explainError(error);

    expect(explanation).toMatch(/changed in another session/i);
    expect(explanation).toMatch(/reload/i);
    expect(explanation).not.toContain('lock_version');
  });

  it('guides authentication failures to settings', () => {
    const explanation = explainError(new ApiError(401, { code: 'HTTP_401', message: 'Unauthorized' }));

    expect(explanation).toMatch(/browser session/i);
    expect(explanation).toMatch(/settings/i);
  });

  it('explains the picture upload size limits', () => {
    const explanation = explainError(new ApiError(413, { code: 'PAYLOAD_TOO_LARGE' }));

    expect(explanation).toMatch(/3 pictures/i);
    expect(explanation).toMatch(/100 MB/i);
  });
});
