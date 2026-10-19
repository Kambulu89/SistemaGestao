import { DRIVER_V1, NOTE_V1, VEHICLE_V1, VEHICLE_V2 } from '../../mock/mock-entities';
import { defineEntity } from './define-entity';
import { resolvePublished, versionsOf } from './resolve-definitions';

const note = (over: Partial<Parameters<typeof defineEntity>[0]>) =>
  defineEntity({
    key: 'note',
    names: { singular: 'Nota', plural: 'Notas' },
    icon: 'document',
    fields: [{ type: 'text', key: 'titulo', label: 'Título' }],
    ...over,
  });

describe('resolvePublished', () => {
  const all = [NOTE_V1, VEHICLE_V1, VEHICLE_V2, DRIVER_V1];

  it('picks the highest published version of each entity, sorted by name', () => {
    const result = resolvePublished(all, 't-atlas');
    expect(result.map((d) => `${d.key}@${d.version}`)).toEqual(['driver@1', 'note@1', 'vehicle@2']);
  });

  it('ignores archived versions and drafts', () => {
    const draft = defineEntity({
      ...{ key: 'vehicle', tenantId: 't-atlas', version: 3, state: 'draft' },
      names: { singular: 'V', plural: 'V' },
      icon: 'truck',
      fields: [{ type: 'text', key: 'a', label: 'A' }],
    });
    expect(resolvePublished([VEHICLE_V1, VEHICLE_V2, draft], 't-atlas')[0]?.version).toBe(2);
  });

  it('hides other tenants definitions even if the server returns them', () => {
    expect(resolvePublished(all, 't-escola').map((d) => d.key)).toEqual(['note']);
  });

  it('lets a tenant definition override the global one with the same key', () => {
    const custom = note({ scope: 'tenant', tenantId: 't-escola', version: 1 });
    const result = resolvePublished([NOTE_V1, custom], 't-escola');
    expect(result).toHaveLength(1);
    expect(result[0]?.scope).toBe('tenant');
  });

  it('keeps the global one for tenants without an override', () => {
    const custom = note({ scope: 'tenant', tenantId: 't-escola', version: 1 });
    expect(resolvePublished([NOTE_V1, custom], 't-atlas')[0]?.scope).toBe('global');
  });

  it('lists versions of one entity, newest first, scoped to the tenant', () => {
    expect(versionsOf(all, 'vehicle', 't-atlas').map((d) => d.version)).toEqual([2, 1]);
    expect(versionsOf(all, 'vehicle', 't-escola')).toEqual([]);
  });
});
