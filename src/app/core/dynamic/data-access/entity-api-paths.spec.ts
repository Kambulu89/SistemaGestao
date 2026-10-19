import { ENTITY_API, recordQueryParams } from './entity-api-paths';

describe('proposed entity API contract', () => {
  it('builds the proposed paths', () => {
    expect(ENTITY_API.entities()).toBe('v1/entities');
    expect(ENTITY_API.definition('vehicle')).toBe('v1/entities/vehicle/definition');
    expect(ENTITY_API.records('vehicle')).toBe('v1/entities/vehicle/records');
    expect(ENTITY_API.record('vehicle', 'r1')).toBe('v1/entities/vehicle/records/r1');
    expect(ENTITY_API.transitions('vehicle', 'r1')).toBe(
      'v1/entities/vehicle/records/r1/transitions',
    );
    expect(ENTITY_API.audit('vehicle', 'r1')).toBe('v1/entities/vehicle/records/r1/audit');
    expect(ENTITY_API.lookup('vehicle')).toBe('v1/entities/vehicle/records/lookup');
  });

  it('encodes path segments', () => {
    expect(ENTITY_API.record('a/b', 'x y')).toBe('v1/entities/a%2Fb/records/x%20y');
  });

  it('maps a record query to query parameters (the tenant is never part of the URL)', () => {
    expect(
      recordQueryParams({
        page: 2,
        pageSize: 8,
        sort: { key: 'matricula', direction: 'desc' },
        search: 'volvo',
        filters: { combustivel: 'gasoleo', status: 'available' },
      }),
    ).toEqual({
      page: 2,
      pageSize: 8,
      sort: 'matricula:desc',
      search: 'volvo',
      'filter.combustivel': 'gasoleo',
      'filter.status': 'available',
    });
  });

  it('omits empty search and filters', () => {
    expect(recordQueryParams({ page: 1, pageSize: 10 })).toEqual({ page: 1, pageSize: 10 });
  });
});
