import { amountOrNull, NOTE_REASONS, noteTone } from './note-model';

describe('note-model', () => {
  it('normaliza valores sem float', () => {
    expect(amountOrNull(' 12,50 ')).toBe('12.50');
    expect(amountOrNull('0,00')).toBeNull();
    expect(amountOrNull('')).toBeNull();
  });
  it('motivos por tipo e tons semânticos', () => {
    expect(NOTE_REASONS.DEBIT).not.toContain('RETURN');
    expect(NOTE_REASONS.CREDIT).toContain('RETURN');
    expect(noteTone('ISSUED')).toContain('success');
    expect(noteTone('DRAFT')).toContain('warning');
  });
});
