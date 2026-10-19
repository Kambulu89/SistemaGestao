import { errorMessage } from './error-message';

describe('errorMessage', () => {
  it('reads an ApiError directly', () => {
    expect(errorMessage({ status: 404, message: 'Registo não encontrado.' })).toBe(
      'Registo não encontrado.',
    );
  });

  it('unwraps the cause that rxResource attaches to non-Error failures', () => {
    const wrapped = new Error(
      "Resource returned an error that's not an Error instance: [object Object].",
      {
        cause: { status: 403, message: 'Sem permissão.' },
      },
    );
    expect(errorMessage(wrapped)).toBe('Sem permissão.');
  });

  it('keeps the message of a genuine Error', () => {
    expect(errorMessage(new Error('boom'))).toBe('boom');
  });

  it('falls back for anything else', () => {
    expect(errorMessage(undefined)).toContain('inesperado');
    expect(errorMessage('texto')).toContain('inesperado');
    expect(errorMessage(null, 'x')).toBe('x');
  });
});
