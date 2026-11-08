import { visibleColumns } from './data-table';
import { chipText } from './filter-bar';
import { DRAFT_MAX_AGE_MS, parseDraft } from '../core/drafts';
import { moneyOf } from '../accounting/entries';

describe('colunas configuráveis', () => {
  const cols = [
    { key: 'a', label: 'A', required: true },
    { key: 'b', label: 'B' },
    { key: 'c', label: 'C', hiddenByDefault: true },
  ];
  it('predefinição esconde as marcadas; a escolha guardada manda; obrigatórias nunca saem', () => {
    expect(visibleColumns(cols, null).map((c) => c.key)).toEqual(['a', 'b']);
    expect(visibleColumns(cols, new Set(['a', 'b'])).map((c) => c.key)).toEqual(['a', 'c']);
  });
});

describe('etiquetas de filtros', () => {
  it('mostra o rótulo da opção e datas em dd/mm/aaaa', () => {
    expect(
      chipText(
        { key: 's', label: 'Estado', options: [{ value: 'POSTED', label: 'Contabilizado' }] },
        'POSTED',
      ),
    ).toBe('Estado: Contabilizado');
    expect(chipText({ key: 'd', label: 'De', type: 'date' }, '2026-02-01')).toBe('De: 01/02/2026');
  });
});

describe('rascunhos', () => {
  it('ignora rascunhos inválidos ou antigos', () => {
    const now = Date.parse('2026-11-08T12:00:00Z');
    const fresh = JSON.stringify({ value: { a: 1 }, savedAt: '2026-11-07T12:00:00Z' });
    const old = JSON.stringify({
      value: { a: 1 },
      savedAt: new Date(now - DRAFT_MAX_AGE_MS - 1000).toISOString(),
    });
    expect(parseDraft(fresh, now)?.value).toEqual({ a: 1 });
    expect(parseDraft(old, now)).toBeNull();
    expect(parseDraft('{', now)).toBeNull();
    expect(parseDraft(null, now)).toBeNull();
  });
});

describe('valores monetários da API', () => {
  it('formata sem passar por número e trata vazio', () => {
    expect(moneyOf(null)).toBe('—');
    expect(moneyOf('1234.50')).toContain('1');
  });
});
