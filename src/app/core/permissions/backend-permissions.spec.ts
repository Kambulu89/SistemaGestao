import { mapBackendPermissions } from './backend-permissions';

describe('mapBackendPermissions (D-014)', () => {
  it('keeps the server codes and adds the keys the frontend pages expect', () => {
    expect(mapBackendPermissions(['member.invite'])).toEqual([
      'iam.users.manage',
      'iam.users.read',
      'member.invite',
    ]);
    expect(mapBackendPermissions(['organization.read'])).toContain('organization.units.read');
    expect(mapBackendPermissions(['iam.read'])).toContain('iam.access-control.read');
  });

  it('entity.* open the Core Dinâmico pages; dynamic.* stay as they are (records use them directly)', () => {
    expect(mapBackendPermissions(['entity.read'])).toEqual([
      'configuration.forms.read',
      'entity.read',
    ]);
    const design = mapBackendPermissions(['entity.design']);
    expect(design).toEqual(
      expect.arrayContaining(['configuration.forms.read', 'configuration.forms.manage']),
    );
    expect(design).not.toContain('configuration.forms.publish');
    expect(mapBackendPermissions(['entity.publish'])).toContain('configuration.forms.publish');
    expect(mapBackendPermissions(['dynamic.read', 'dynamic.sensitive'])).toEqual([
      'dynamic.read',
      'dynamic.sensitive',
    ]);
  });

  it('manage implies read in the frontend keys, but read never implies manage', () => {
    const read = mapBackendPermissions(['organization.read']);
    expect(read).not.toContain('organization.units.manage');
    const manage = mapBackendPermissions(['organization.manage']);
    expect(manage).toEqual(
      expect.arrayContaining(['organization.units.read', 'organization.units.manage']),
    );
  });

  it('passes unknown codes through, never invents permissions and never grants platform.*', () => {
    expect(mapBackendPermissions(['party.read'])).toEqual(['party.read']);
    expect(mapBackendPermissions([])).toEqual([]);
    expect(
      mapBackendPermissions(['iam.manage', 'member.manage']).some((p) => p.startsWith('platform.')),
    ).toBe(false);
  });

  it('deduplicates', () => {
    const result = mapBackendPermissions(['member.invite', 'member.manage']);
    expect(new Set(result).size).toBe(result.length);
  });
});
