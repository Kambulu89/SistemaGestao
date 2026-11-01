import { detailedErrorMessage, errorMessage } from './error-message';

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

describe('detailedErrorMessage', () => {
  const api = {
    status: 422,
    message: 'Verifique os campos indicados.',
    fieldErrors: [
      { path: 'code', code: 'INVALID_CODE', message: 'Código inválido.' },
      { path: 'name', code: 'REQUIRED', message: 'Indique o nome.' },
    ],
  };

  it('names the fields that failed', () => {
    expect(detailedErrorMessage(api)).toBe('Código inválido. Indique o nome.');
  });

  it('unwraps the cause that rxResource attaches', () => {
    expect(detailedErrorMessage(new Error('x', { cause: api }))).toBe(
      'Código inválido. Indique o nome.',
    );
  });

  it('falls back to the plain message and then to the fallback', () => {
    expect(detailedErrorMessage({ status: 409, message: 'Código repetido.' })).toBe(
      'Código repetido.',
    );
    expect(detailedErrorMessage(null, 'nada')).toBe('nada');
  });
});
