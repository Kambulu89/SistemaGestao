import { ORG_KINDS, payloadFor } from './org-kinds';

describe('payloadFor', () => {
  const positions = ORG_KINDS['positions'];

  it('na criação envia só os campos preenchidos, aparados e com números', () => {
    const body = payloadFor(
      positions,
      { code: ' P1 ', name: 'Analista', level: '3', jobFamily: '', status: 'ACTIVE' },
      null,
    );
    expect(body).toEqual({ code: 'P1', name: 'Analista', level: 3, status: 'ACTIVE' });
  });

  it('na alteração envia só o que mudou e nunca os imutáveis', () => {
    const original = {
      id: 'x',
      version: 2,
      code: 'P1',
      name: 'Analista',
      level: 3,
      jobFamily: null,
      status: 'ACTIVE',
    };
    const body = payloadFor(
      positions,
      { ...original, code: 'OUTRO', name: 'Analista sénior', jobFamily: '' },
      original,
    );
    expect(body).toEqual({ name: 'Analista sénior' });
  });

  it('limpar um campo opcional envia null', () => {
    const original = {
      id: 'x',
      version: 1,
      code: 'P1',
      name: 'A',
      jobFamily: 'TI',
      status: 'ACTIVE',
    };
    expect(payloadFor(positions, { ...original, jobFamily: '  ' }, original)).toEqual({
      jobFamily: null,
    });
  });
});
