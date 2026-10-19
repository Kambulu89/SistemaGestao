import {
  buildField,
  codeFromName,
  ENTITY_KEY_PATTERN,
  entityKeyFromName,
  draftOf,
  EMPTY_DRAFT,
  type FieldDraft,
} from './field-draft';

const draft = (overrides: Partial<FieldDraft>): FieldDraft => ({
  ...EMPTY_DRAFT,
  code: 'campo',
  name: 'Campo',
  ...overrides,
});
const ctx = { entityKey: 'customer' };

describe('codeFromName', () => {
  it('builds a camelCase code without accents or symbols', () => {
    expect(codeFromName('Sector de actividade')).toBe('sectorDeActividade');
    expect(codeFromName('NIF secundário')).toBe('nifSecundario');
    expect(codeFromName('  Código   interno! ')).toBe('codigoInterno');
  });

  it('prefixes names that do not start with a letter', () => {
    expect(codeFromName('2.º contacto')).toBe('campo2Contacto');
    expect(codeFromName('')).toBe('');
  });
});

describe('buildField / draftOf', () => {
  it('builds a select with trimmed options and keeps inactive ones', () => {
    const field = buildField(
      draft({
        type: 'select',
        options: [
          { value: ' a ', label: ' A ' },
          { value: 'b', label: 'B', active: false },
        ],
      }),
      ctx,
    );
    expect(field).toMatchObject({ type: 'select' });
    expect('options' in field && field.options).toEqual([
      { value: 'a', label: 'A' },
      { value: 'b', label: 'B', active: false },
    ]);
  });

  it('ignores options on types that do not have them and flags only what the type allows', () => {
    const field = buildField(
      draft({ type: 'boolean', searchable: true, filterable: true, unique: true, min: 3 }),
      ctx,
    );
    expect(field.searchable).toBe(false); // boolean não é pesquisável
    expect(field.validations.some((r) => r.type === 'unique')).toBe(false);
    expect(field.validations.some((r) => r.type === 'min')).toBe(false);
    expect(field).not.toHaveProperty('options');
  });

  it('marks sensitive fields with explicit read/write permissions', () => {
    const field = buildField(draft({ sensitive: true }), ctx);
    expect(field.sensitivity).toBe('sensitive');
    expect(field.permissions).toEqual({
      read: 'entities.customer.sensitive.read',
      write: 'entities.customer.sensitive.write',
    });
  });

  it('builds currency with precision and limits', () => {
    const field = buildField(draft({ type: 'currency', currency: 'aoa', scale: 2, min: 0 }), ctx);
    expect(field).toMatchObject({ type: 'currency', currency: 'AOA', scale: 2 });
    expect(field.validations).toEqual([{ type: 'min', value: 0 }]);
  });

  it('builds a file field with MIME list and size in bytes', () => {
    const field = buildField(
      draft({ type: 'file', accept: 'application/pdf, image/png', maxSizeMb: 2, multiple: true }),
      ctx,
    );
    expect(field).toMatchObject({
      accept: ['application/pdf', 'image/png'],
      maxSizeBytes: 2 * 1024 * 1024,
      multiple: true,
    });
  });

  it('round-trips a field through the draft', () => {
    const original = buildField(
      draft({
        type: 'decimal',
        scale: 3,
        min: 1,
        max: 9,
        required: true,
        unique: false,
        description: 'Descrição',
      }),
      ctx,
    );
    const again = buildField(draftOf(original), ctx);
    expect(again).toEqual(original);
  });

  it('round-trips options, sensitivity and file settings', () => {
    for (const d of [
      draft({ type: 'radio', options: [{ value: 'x', label: 'X' }], sensitive: true }),
      draft({ type: 'image', accept: 'image/png', maxSizeMb: 1.5 }),
      draft({ type: 'text', unique: true, minLength: 2, maxLength: 9 }),
    ]) {
      const field = buildField(d, ctx);
      expect(buildField(draftOf(field), ctx)).toEqual(field);
    }
  });
});

describe('buildField: campo existente e referências', () => {
  it('keeps what the designer does not edit (default, conditions, other rules)', () => {
    const base = buildField(draft({ type: 'text', maxLength: 5 }), ctx);
    const rich = {
      ...base,
      defaultValue: 'x',
      visibleWhen: { op: 'eq', field: 'a', value: 1 },
      validations: [...base.validations, { type: 'pattern', pattern: '^[a-z]+$' }],
    } as typeof base;
    const edited = buildField({ ...draftOf(rich), name: 'Novo nome', maxLength: 9 }, ctx, rich);
    expect(edited.label).toBe('Novo nome');
    expect(edited.defaultValue).toBe('x');
    expect(edited.visibleWhen).toEqual(rich.visibleWhen);
    expect(edited.validations).toEqual(
      expect.arrayContaining([
        { type: 'pattern', pattern: '^[a-z]+$' },
        { type: 'maxLength', value: 9 },
      ]),
    );
    expect(edited.validations.filter((r) => r.type === 'maxLength')).toHaveLength(1);
  });

  it('builds an entity reference with its target entity', () => {
    const field = buildField(draft({ type: 'entity-reference', referenceEntity: 'vehicle' }), ctx);
    expect(field).toMatchObject({ type: 'entity-reference', entityKey: 'vehicle' });
    expect(draftOf(field).referenceEntity).toBe('vehicle');
  });
});

describe('entityKeyFromName', () => {
  it('builds a lowercase hyphenated key that satisfies the integrity rule', () => {
    expect(entityKeyFromName('Equipamento')).toBe('equipamento');
    expect(entityKeyFromName('Ordem de serviço')).toBe('ordem-de-servico');
    expect(entityKeyFromName('  Viatura (frota)! ')).toBe('viatura-frota');
    expect(entityKeyFromName('3D')).toBe('e-3d');
    expect(entityKeyFromName('')).toBe('');
    for (const name of ['Equipamento', 'Ordem de serviço', 'Viatura (frota)']) {
      expect(ENTITY_KEY_PATTERN.test(entityKeyFromName(name))).toBe(true);
    }
  });

  it('never produces a trailing hyphen after truncating', () => {
    expect(entityKeyFromName('a'.repeat(29) + ' bbb')).not.toMatch(/-$/);
  });
});
