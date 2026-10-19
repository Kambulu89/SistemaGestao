import { autoNumberPeriod, formatAutoNumber, validateAutoNumber } from './auto-number';
import { defineEntity } from './define-entity';
import { validateEntityDefinition } from './definition-integrity';

const DEF = { prefix: 'EQ-', padding: 4, start: 1, reset: 'never' as const };

describe('auto-number', () => {
  it('formats prefix, period and zero-padded sequence', () => {
    const at = new Date('2026-10-19T10:00:00Z');
    expect(formatAutoNumber(DEF, 7, at)).toBe('EQ-0007');
    expect(formatAutoNumber({ ...DEF, reset: 'yearly' }, 7, at)).toBe('EQ-2026-0007');
    expect(formatAutoNumber({ ...DEF, reset: 'monthly' }, 12, at)).toBe('EQ-202610-0012');
    expect(formatAutoNumber({ ...DEF, padding: 2 }, 12345, at)).toBe('EQ-12345'); // nunca trunca
  });

  it('uses the period as the sequence scope', () => {
    expect(autoNumberPeriod('never', new Date('2026-01-01T00:00:00Z'))).toBe('');
    expect(autoNumberPeriod('yearly', new Date('2026-12-31T23:59:59Z'))).toBe('2026');
    expect(autoNumberPeriod('monthly', new Date('2026-02-03T00:00:00Z'))).toBe('202602');
  });

  it('validates the configuration', () => {
    expect(validateAutoNumber(DEF)).toEqual([]);
    expect(validateAutoNumber({ ...DEF, prefix: 'A B' })).toHaveLength(1);
    expect(validateAutoNumber({ ...DEF, prefix: 'X'.repeat(13) })).toHaveLength(1);
    expect(validateAutoNumber({ ...DEF, padding: 0 })).toHaveLength(1);
    expect(validateAutoNumber({ ...DEF, padding: 13 })).toHaveLength(1);
    expect(validateAutoNumber({ ...DEF, start: -1 })).toHaveLength(1);
    expect(validateAutoNumber({ ...DEF, start: 1.5 })).toHaveLength(1);
    expect(validateAutoNumber({ ...DEF, reset: 'weekly' as never })).toHaveLength(1);
  });

  it('is enforced by the definition integrity rules', () => {
    const entity = (autoNumber: typeof DEF, extra: object = {}) =>
      defineEntity({
        key: 'equipamento',
        scope: 'tenant',
        tenantId: 't',
        names: { singular: 'E', plural: 'Es' },
        icon: 'cube',
        fields: [{ type: 'auto-number', key: 'codigo', label: 'Código', autoNumber, ...extra }],
      });
    const errors = (e: ReturnType<typeof entity>) =>
      validateEntityDefinition(e)
        .filter((i) => i.severity === 'error')
        .map((i) => i.message);
    expect(errors(entity(DEF))).toEqual([]);
    expect(errors(entity({ ...DEF, padding: 99 }))).toHaveLength(1);
    expect(errors(entity(DEF, { required: true })).join(' ')).toContain('não pode ser obrigatória');
  });
});
