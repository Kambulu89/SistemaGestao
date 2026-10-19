import { VEHICLE_V1, VEHICLE_V2 } from '../../mock/mock-entities';
import { defineEntity, type EntityInput, type FieldInput } from './define-entity';
import { checkPublishable, diffDefinitions } from './definition-compat';

const entity = (fields: readonly FieldInput[], over: Partial<EntityInput> = {}) =>
  defineEntity({
    key: 'thing',
    tenantId: 't',
    names: { singular: 'T', plural: 'Ts' },
    icon: 'cube',
    ...over,
    fields,
  });

const text = (key: string, extra: Partial<FieldInput> = {}): FieldInput =>
  ({ type: 'text', key, label: key, ...extra }) as FieldInput;

describe('definition versioning', () => {
  it('Viatura v1 → v2 (adds numeroChassis) is safe', () => {
    expect(diffDefinitions(VEHICLE_V1, VEHICLE_V2)).toEqual([
      { severity: 'safe', path: 'fields.numeroChassis', message: 'Campo acrescentado.' },
    ]);
  });

  it('flags a removed (or renamed) field as breaking', () => {
    const v1 = entity([text('a'), text('b')]);
    const v2 = entity([text('a'), text('c')], { version: 2 });
    const breaking = diffDefinitions(v1, v2).filter((c) => c.severity === 'breaking');
    expect(breaking.map((c) => c.path)).toEqual(['fields.b']);
  });

  it('archiving a field keeps the data and is safe', () => {
    const v1 = entity([text('a'), text('b')]);
    const v2 = entity([text('a'), text('b', { archived: true })], { version: 2 });
    expect(diffDefinitions(v1, v2).filter((c) => c.severity === 'breaking')).toEqual([]);
    expect(diffDefinitions(v1, v2)[0]?.message).toContain('arquivado');
  });

  it('flags type changes and removed options as breaking', () => {
    const options = [
      { value: 'a', label: 'A' },
      { value: 'b', label: 'B' },
    ];
    const v1 = entity([{ type: 'select', key: 's', label: 'S', options }, text('n')]);
    const v2 = entity(
      [
        { type: 'select', key: 's', label: 'S', options: [options[0]!] },
        { type: 'number', key: 'n', label: 'N' },
      ],
      { version: 2 },
    );
    const messages = diffDefinitions(v1, v2)
      .filter((c) => c.severity === 'breaking')
      .map((c) => c.message);
    expect(messages).toEqual(['Opções retiradas: b.', 'O tipo mudou de text para number.']);
  });

  it('warns when a field becomes required or a required field is added without default', () => {
    const v1 = entity([text('a')]);
    const v2 = entity([text('a', { required: true }), text('b', { required: true })], {
      version: 2,
    });
    expect(diffDefinitions(v1, v2).map((c) => [c.severity, c.path])).toEqual([
      ['warning', 'fields.a'],
      ['warning', 'fields.b'],
    ]);
  });

  it('accepts a required new field that has a default value', () => {
    const v2 = entity([text('a'), text('b', { required: true, defaultValue: 'x' })], {
      version: 2,
    });
    expect(diffDefinitions(entity([text('a')]), v2).map((c) => c.severity)).toEqual(['safe']);
  });

  it('requires the version to increase by one and removed statuses to be flagged', () => {
    const withStatus = (version: number, codes: string[]) =>
      entity([text('a')], { version, statuses: codes.map((code) => ({ code, name: code })) });
    const changes = diffDefinitions(withStatus(1, ['x', 'y']), withStatus(3, ['x']));
    expect(changes.filter((c) => c.severity === 'breaking').map((c) => c.path)).toEqual([
      'version',
      'statuses.y',
    ]);
  });
});

describe('checkPublishable', () => {
  const draft = (over: Partial<EntityInput> = {}) =>
    entity([text('a'), text('b')], { version: 2, state: 'draft', ...over });
  const published = entity([text('a'), text('b')], { version: 1 });

  it('allows a safe draft', () => {
    expect(checkPublishable(published, draft()).ok).toBe(true);
  });

  it('blocks drafts with breaking changes', () => {
    const result = checkPublishable(published, entity([text('a')], { version: 2, state: 'draft' }));
    expect(result.ok).toBe(false);
    expect(result.breaking).toHaveLength(1);
  });

  it('blocks drafts with integrity errors', () => {
    const broken = entity([text('a'), text('a')], { version: 2, state: 'draft' });
    const result = checkPublishable(published, broken);
    expect(result.ok).toBe(false);
    expect(result.issues.some((i) => i.severity === 'error')).toBe(true);
  });

  it('only drafts can be published, and a first version has nothing to compare', () => {
    expect(checkPublishable(null, entity([text('a')], { state: 'draft' })).ok).toBe(true);
    expect(checkPublishable(null, entity([text('a')], { state: 'published' })).ok).toBe(false);
  });
});
