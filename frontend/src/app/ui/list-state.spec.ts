import { fromQueryParams, toApiQuery, toQueryParams } from './list-state';

describe('estado das listas na URL', () => {
  it('só põe na URL o que difere da predefinição', () => {
    expect(toQueryParams({ q: '  ', filters: { status: '' }, sort: null, offset: 0 })).toEqual({});
    expect(
      toQueryParams({
        q: ' ana ',
        filters: { status: 'ACTIVE', journalId: '' },
        sort: { field: 'email', direction: 'desc' },
        offset: 50,
      }),
    ).toEqual({ q: 'ana', status: 'ACTIVE', sort: 'email', direction: 'desc', offset: '50' });
  });

  it('da URL só aceita filtros e ordenações conhecidos', () => {
    const s = fromQueryParams(
      { q: 'x', status: 'ACTIVE', evil: '1', sort: 'password', offset: '-3' },
      ['status'],
      ['email'],
    );
    expect(s).toEqual({ q: 'x', filters: { status: 'ACTIVE' }, sort: null, offset: 0 });
    expect(fromQueryParams({ sort: 'email' }, [], ['email']).sort).toEqual({
      field: 'email',
      direction: 'asc',
    });
  });

  it('consulta da API com âmbito, filtros, ordenação e paginação', () => {
    expect(
      toApiQuery(
        {
          q: 'v',
          filters: { dateFrom: '2026-01-01' },
          sort: { field: 'number', direction: 'asc' },
          offset: 25,
        },
        25,
        { legalEntityId: 'le-1' },
      ),
    ).toEqual({
      legalEntityId: 'le-1',
      q: 'v',
      dateFrom: '2026-01-01',
      sort: 'number',
      direction: 'asc',
      limit: 25,
      offset: 25,
    });
  });
});
