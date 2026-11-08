import { auditQuery } from './audit';

describe('auditoria: consulta para a API', () => {
  it('converte o dia local em instantes ISO (início e fim do dia)', () => {
    const q = auditQuery({ from: '2026-11-01', to: '2026-11-08', action: 'member.*', limit: 50 });
    expect(q['action']).toBe('member.*');
    expect(q['from']).toBe(new Date('2026-11-01T00:00:00').toISOString());
    expect(q['to']).toBe(new Date('2026-11-08T23:59:59.999').toISOString());
  });

  it('sem datas não acrescenta nada', () => {
    expect(auditQuery({ limit: 50, offset: 0 })).toEqual({ limit: 50, offset: 0 });
  });
});
