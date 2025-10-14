const { _internals } = require('../server/index.js');

const { isRetryableError } = _internals;

describe('isRetryableError helper', () => {
  it('treats AbortError as retryable', () => {
    const err = new Error('This operation was aborted');
    err.name = 'AbortError';
    expect(isRetryableError(err)).toBe(true);
  });

  it('treats timeout messages as retryable', () => {
    const err = new Error('Request timed out after 30s');
    err.httpStatus = 504;
    expect(isRetryableError(err)).toBe(true);
  });

  it('respects non-retryable errors', () => {
    const err = new Error('Invalid API key');
    err.httpStatus = 401;
    expect(isRetryableError(err)).toBe(false);
  });
});
