import { CUSTOMER_V1, VEHICLE_V2 } from '../../mock/mock-entities';
import type { CustomFieldDefinition } from '../models/custom-definition.model';
import type { FieldDefinition } from '../models/field-definition.model';
import {
  checkCustomFieldChange,
  CUSTOM_SECTION_TITLE,
  mergeCustomFields,
  mergeCustomFieldsDetailed,
  validateCustomFieldDefinition,
} from './custom-fields';
import { defineEntity, type FieldInput } from './define-entity';

const audit = { createdAt: '2026-01-01', createdBy: 'u', updatedAt: '2026-01-01', updatedBy: 'u' };

function custom(
  tenantId: string,
  field: FieldInput,
  over: Partial<CustomFieldDefinition> = {},
): CustomFieldDefinition {
  const [defined] = defineEntity({
    key: 'tmp',
    tenantId: 't',
    names: { singular: 'T', plural: 'T' },
    icon: 'cube',
    fields: [field],
  }).fields;
  return {
    id: `cf-${tenantId}-${defined!.key}`,
    tenantId,
    entity: { kind: 'core', key: 'customer' },
    field: { ...defined!, origin: 'custom' } as FieldDefinition,
    displayOrder: 1,
    showInList: false,
    state: 'active',
    version: 1,
    audit,
    ...over,
  };
}

const sector = (tenant: string, over: Partial<CustomFieldDefinition> = {}) =>
  custom(
    tenant,
    {
      type: 'select',
      key: 'sectorActividade',
      label: 'Sector de actividade',
      filterable: true,
      options: [
        { value: 'saude', label: 'Saúde' },
        { value: 'educacao', label: 'Educação' },
      ],
    },
    over,
  );

describe('mergeCustomFields (Caso A: extensão de Cliente)', () => {
  const tenantA = [
    sector('A'),
    custom('A', { type: 'text', key: 'categoria', label: 'Categoria' }, { displayOrder: 2 }),
  ];
  const tenantB = [
    custom('B', { type: 'text', key: 'regiaoComercial', label: 'Região comercial' }),
    custom(
      'B',
      { type: 'text', key: 'codigoInterno', label: 'Código interno' },
      { displayOrder: 2 },
    ),
  ];
  const all = [...tenantA, ...tenantB];

  it('cada tenant vê só os seus campos, depois dos nativos', () => {
    const a = mergeCustomFields(CUSTOMER_V1, all, 'A');
    const b = mergeCustomFields(CUSTOMER_V1, all, 'B');
    expect(a.fields.map((f) => f.key)).toEqual([
      'nome',
      'email',
      'telefone',
      'sectorActividade',
      'categoria',
    ]);
    expect(b.fields.map((f) => f.key)).toEqual([
      'nome',
      'email',
      'telefone',
      'regiaoComercial',
      'codigoInterno',
    ]);
    expect(mergeCustomFields(CUSTOMER_V1, all, 'C').fields).toHaveLength(3);
  });

  it('marca a origem de cada campo', () => {
    const a = mergeCustomFields(CUSTOMER_V1, all, 'A');
    expect(a.fields.map((f) => f.origin ?? 'core')).toEqual([
      'core',
      'core',
      'core',
      'custom',
      'custom',
    ]);
  });

  it('nunca altera a definição nativa', () => {
    const before = JSON.stringify(CUSTOMER_V1);
    mergeCustomFields(CUSTOMER_V1, all, 'A');
    expect(JSON.stringify(CUSTOMER_V1)).toBe(before);
  });

  it('ordena por displayOrder e coloca-os depois dos nativos', () => {
    const reversed = [
      custom('A', { type: 'text', key: 'z', label: 'Z' }, { displayOrder: 5 }),
      custom('A', { type: 'text', key: 'a', label: 'A' }, { displayOrder: 1 }),
    ];
    const merged = mergeCustomFields(CUSTOMER_V1, reversed, 'A');
    expect(merged.fields.slice(3).map((f) => f.key)).toEqual(['a', 'z']);
    expect(Math.min(...merged.fields.slice(3).map((f) => f.order))).toBeGreaterThan(
      Math.max(...merged.fields.slice(0, 3).map((f) => f.order)),
    );
  });

  it('só funde campos activos (rascunhos a pedido; arquivados nunca)', () => {
    const states = [
      sector('A', { state: 'draft' }),
      custom('A', { type: 'text', key: 'velho', label: 'Velho' }, { state: 'archived' }),
    ];
    expect(mergeCustomFields(CUSTOMER_V1, states, 'A').fields).toHaveLength(3);
    expect(
      mergeCustomFields(CUSTOMER_V1, states, 'A', { includeDrafts: true }).fields.map((f) => f.key),
    ).toContain('sectorActividade');
    expect(
      mergeCustomFields(CUSTOMER_V1, states, 'A', { includeDrafts: true }).fields.map((f) => f.key),
    ).not.toContain('velho');
  });

  it('ignora campos de outra entidade e entidades não extensíveis', () => {
    const other = sector('A', { entity: { kind: 'core', key: 'supplier' } });
    expect(mergeCustomFields(CUSTOMER_V1, [other], 'A').fields).toHaveLength(3);
    expect(mergeCustomFields(VEHICLE_V2, [sector('A')], 'A')).toBe(VEHICLE_V2);
  });

  it('recusa colisões de código com campos nativos e entre campos', () => {
    const clash = custom('A', { type: 'text', key: 'nome', label: 'Nome 2' });
    const dup = [sector('A'), { ...sector('A'), id: 'outro' }];
    expect(mergeCustomFieldsDetailed(CUSTOMER_V1, [clash], 'A').skipped).toEqual([
      { code: 'nome', reason: 'O código colide com um campo existente.' },
    ]);
    expect(
      mergeCustomFieldsDetailed(CUSTOMER_V1, dup, 'A').entity.fields.filter(
        (f) => f.key === 'sectorActividade',
      ),
    ).toHaveLength(1);
  });

  it('inclui os campos no formulário (secção própria), na listagem, pesquisa e filtros', () => {
    const withForm = {
      ...CUSTOMER_V1,
      forms: [
        {
          key: 'f',
          name: 'F',
          modes: ['create', 'edit', 'read'] as const,
          sections: [
            {
              key: 'main',
              title: 'Dados',
              columns: 2 as const,
              items: [{ kind: 'field' as const, field: 'nome' }],
            },
          ],
        },
      ],
    };
    const merged = mergeCustomFields(
      withForm,
      [
        sector('A', { showInList: true }),
        custom(
          'A',
          { type: 'text', key: 'ref', label: 'Ref', searchable: true },
          { displayOrder: 2 },
        ),
      ],
      'A',
    );
    const last = merged.forms[0]!.sections.at(-1)!;
    expect(last.title).toBe(CUSTOM_SECTION_TITLE);
    expect(last.items).toEqual([
      { kind: 'field', field: 'sectorActividade' },
      { kind: 'field', field: 'ref' },
    ]);
    expect(merged.list.columns.map((c) => c.field)).toEqual([
      'nome',
      'email',
      'telefone',
      'sectorActividade',
    ]);
    expect(merged.list.filters).toContain('sectorActividade');
    expect(merged.list.searchFields).toContain('ref');
  });

  it('não repete na secção os campos que o formulário nativo já referencia', () => {
    const withForm = {
      ...CUSTOMER_V1,
      forms: [
        {
          key: 'f',
          name: 'F',
          modes: ['create'] as const,
          sections: [
            {
              key: 'main',
              title: 'Dados',
              columns: 2 as const,
              items: [{ kind: 'field' as const, field: 'sectorActividade' }],
            },
          ],
        },
      ],
    };
    expect(mergeCustomFields(withForm, [sector('A')], 'A').forms[0]!.sections).toHaveLength(1);
  });

  it('não põe na listagem campos que não são listáveis nem pesquisáveis sem suporte', () => {
    const f = custom(
      'A',
      { type: 'file', key: 'anexo', label: 'Anexo', searchable: false },
      { showInList: true },
    );
    expect(mergeCustomFields(CUSTOMER_V1, [f], 'A').list.searchFields).toEqual(['nome', 'email']);
  });
});

describe('validateCustomFieldDefinition', () => {
  const messages = (
    candidate: CustomFieldDefinition,
    siblings: CustomFieldDefinition[] = [],
    entity = CUSTOMER_V1,
  ) =>
    validateCustomFieldDefinition(entity, candidate, siblings)
      .map((i) => i.message)
      .join(' | ');

  it('aceita um campo bem definido', () => {
    expect(validateCustomFieldDefinition(CUSTOMER_V1, sector('A'), [])).toEqual([]);
  });

  it('exige uma entidade existente, extensível e coerente', () => {
    expect(validateCustomFieldDefinition(undefined, sector('A'), [])[0]?.message).toContain(
      'não existe',
    );
    expect(messages(sector('A'), [], VEHICLE_V2 as never)).toContain(
      'não aceita campos personalizados',
    );
    expect(messages(sector('A', { entity: { kind: 'core', key: 'supplier' } }))).toContain(
      'não pertence a esta entidade',
    );
  });

  it('exige origin custom e tenant', () => {
    const notCustom = { ...sector('A'), field: { ...sector('A').field, origin: 'core' as const } };
    expect(messages(notCustom)).toContain('origin "custom"');
    expect(messages(sector('A', { tenantId: '' }))).toContain('tenant proprietário');
  });

  it('recusa códigos que colidem com campos nativos ou existentes, mesmo arquivados', () => {
    expect(messages(custom('A', { type: 'text', key: 'email', label: 'E' }))).toContain(
      'colide com um campo nativo',
    );
    expect(messages(sector('A'), [{ ...sector('A'), id: 'x', state: 'archived' }])).toContain(
      'não se reutiliza',
    );
  });

  it('não se confunde com campos de outro tenant', () => {
    expect(
      validateCustomFieldDefinition(CUSTOMER_V1, sector('A'), [{ ...sector('B'), id: 'b1' }]),
    ).toEqual([]);
  });

  it('aplica as regras gerais de campo (capacidades, opções, sensibilidade)', () => {
    const noOptions = custom('A', { type: 'select', key: 'x', label: 'X', options: [] });
    expect(messages(noOptions)).toContain('pelo menos uma opção');
    const badSearch = custom('A', { type: 'file', key: 'f', label: 'F', searchable: true });
    expect(messages(badSearch)).toContain('não suporta pesquisa');
    const sensitive = custom('A', { type: 'text', key: 's', label: 'S', sensitivity: 'sensitive' });
    expect(messages(sensitive)).toContain('permissões explícitas');
  });
});

describe('checkCustomFieldChange', () => {
  const active = sector('A');
  const withState = (f: FieldDefinition, over: Partial<CustomFieldDefinition> = {}) => ({
    ...active,
    field: f,
    ...over,
  });

  it('rascunhos mudam livremente', () => {
    expect(
      checkCustomFieldChange(
        { ...active, state: 'draft' },
        { ...active, field: { ...active.field, type: 'text' } as FieldDefinition },
      ),
    ).toEqual([]);
  });

  it('um campo publicado não muda de código, tipo, entidade ou tenant', () => {
    const renamed = withState({ ...active.field, key: 'outro' } as FieldDefinition);
    expect(
      checkCustomFieldChange(active, renamed).some(
        (c) => c.severity === 'breaking' && c.message.includes('código'),
      ),
    ).toBe(true);
    const retyped = withState({ ...active.field, type: 'text' } as FieldDefinition);
    expect(
      checkCustomFieldChange(active, retyped).some((c) => c.message.includes('O tipo mudou')),
    ).toBe(true);
    expect(
      checkCustomFieldChange(active, { ...active, tenantId: 'B' }).some(
        (c) => c.severity === 'breaking',
      ),
    ).toBe(true);
    expect(
      checkCustomFieldChange(active, { ...active, state: 'draft' }).some((c) =>
        c.message.includes('rascunho'),
      ),
    ).toBe(true);
  });

  it('opções: retirar é destrutivo, desactivar é seguro, acrescentar é seguro', () => {
    const options = (active.field as Extract<FieldDefinition, { type: 'select' }>).options;
    const removed = withState({ ...active.field, options: [options[0]!] } as FieldDefinition);
    expect(
      checkCustomFieldChange(active, removed).filter((c) => c.severity === 'breaking'),
    ).toHaveLength(1);

    const deactivated = withState({
      ...active.field,
      options: [options[0]!, { ...options[1]!, active: false }],
    } as FieldDefinition);
    expect(checkCustomFieldChange(active, deactivated).map((c) => c.severity)).toEqual(['safe']);

    const added = withState({
      ...active.field,
      options: [...options, { value: 'novo', label: 'Novo' }],
    } as FieldDefinition);
    expect(checkCustomFieldChange(active, added).map((c) => c.severity)).toEqual(['safe']);
  });

  it('arquivar preserva os dados; tornar obrigatório, único ou sensível exige atenção', () => {
    expect(
      checkCustomFieldChange(active, { ...active, state: 'archived' }).map((c) => c.severity),
    ).toEqual(['safe']);
    const text = custom('A', { type: 'text', key: 't', label: 'T' });
    const stricter = {
      ...text,
      field: {
        ...text.field,
        required: true,
        validations: [{ type: 'unique' as const }],
      } as FieldDefinition,
    };
    expect(checkCustomFieldChange(text, stricter).map((c) => c.severity)).toEqual([
      'warning',
      'warning',
    ]);
  });

  it('moeda: reduzir precisão ou mudar de moeda é destrutivo', () => {
    const eur = custom('A', { type: 'currency', key: 'v', label: 'V', currency: 'EUR', scale: 2 });
    const less = { ...eur, field: { ...eur.field, scale: 0 } as FieldDefinition };
    const usd = { ...eur, field: { ...eur.field, currency: 'USD' } as FieldDefinition };
    expect(
      checkCustomFieldChange(eur, less).some(
        (c) => c.severity === 'breaking' && c.message.includes('precisão'),
      ),
    ).toBe(true);
    expect(
      checkCustomFieldChange(eur, usd).some(
        (c) => c.severity === 'breaking' && c.message.includes('moeda'),
      ),
    ).toBe(true);
  });
});
