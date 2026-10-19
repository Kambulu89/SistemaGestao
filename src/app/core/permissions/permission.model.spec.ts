import { permissionMatches } from './permission.model';

describe('permissionMatches', () => {
  it.each([
    ['tenant.users.read', 'tenant.users.read', true],
    ['tenant.*', 'tenant.users.read', true],
    ['*', 'anything.at.all', true],
    ['tenant.users.read', 'tenant.users.manage', false],
    ['tenant.*', 'platform.access', false],
    ['tenant.*', 'tenantx.read', false],
  ])('granted %s vs required %s → %s', (granted, required, expected) => {
    expect(permissionMatches(granted, required)).toBe(expected);
  });
});
