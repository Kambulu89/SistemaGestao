import { defineField } from '../engine/define-entity';
import type { FieldDefinition } from '../models/field-definition.model';
import type {
  EntityDetailDto,
  EntityDto,
  FieldDto,
  FieldInputDto,
  VersionDto,
} from './dynamic-dto';
import {
  decimalToNumber,
  decimalToText,
  definitionsFromServer,
  entityCodeOf,
  entityKeyOf,
  fieldCodeOf,
  fieldKeyOf,
  fieldToServer,
  fieldsByCode,
  recordDataFromServer,
  recordDataToServer,
  UnrepresentableDefinitionError,
} from './dynamic-mapper';

const field = (over: Partial<FieldDto> = {}): FieldDto => ({
  code: 'marca',
  label: 'Marca',
  type: 'TEXT',
  required: false,
  defaultValue: null,
  validation: {},
  options: [],
  position: 0,
  sensitive: false,
  readOnly: false,
  archived: false,
  presentation: {},
  ...over,
});

const entity = (over: Partial<EntityDto> = {}): EntityDto => ({
  id: 'e1',
  code: 'ordem_servico',
  name: 'Ordem de serviço',
  description: null,
  status: 'PUBLISHED',
  publishedVersion: 1,
  ownershipMode: 'TENANT',
  presentation: { pluralName: 'Ordens de serviço', icon: 'wrench' },
  version: 7,
  createdAt: '2026-01-01T00:00:00Z',
  updatedAt: '2026-01-02T00:00:00Z',
  ...over,
});

const version = (fields: FieldDto[], over: Partial<VersionDto> = {}): VersionDto => ({
  id: 'v1',
  revision: 1,
  publishedAt: '2026-01-02T00:00:00Z',
  fields,
  ...over,
});

const fieldOf = (dto: FieldDto): FieldDefinition => {
  const detail: EntityDetailDto = { entity: entity(), published: version([dto]), draft: null };
  return definitionsFromServer('t1', detail)[0]!.fields[0]!;
};

const toServer = (f: FieldDefinition) => {
  const issues: { path: string; message: string }[] = [];
  const dto = fieldToServer(f, issues as never, `fields.${f.key}`);
  return { dto, issues };
};

describe('códigos e chaves', () => {
  it('converte entidades entre kebab-case e snake_case', () => {
    expect(entityKeyOf('ordem_servico')).toBe('ordem-servico');
    expect(entityCodeOf('ordem-servico')).toBe('ordem_servico');
  });

  it('converte campos entre camelCase e snake_case, em ambos os sentidos', () => {
    for (const key of ['marca', 'dataCompra', 'nif2', 'x2Y', 'ab', 'urlBase64']) {
      expect(fieldKeyOf(fieldCodeOf(key))).toBe(key);
    }
    expect(fieldCodeOf('dataCompra')).toBe('data_compra');
    expect(fieldKeyOf('data_compra')).toBe('dataCompra');
  });

  it('recusa um código do servidor que não volta a si próprio', () => {
    expect(() => fieldOf(field({ code: 'a__b' }))).toThrow(UnrepresentableDefinitionError);
    expect(() => fieldOf(field({ code: 'a_1' }))).toThrow(UnrepresentableDefinitionError);
  });
});

describe('decimais', () => {
  it('só converte o que cabe exactamente num número', () => {
    expect(decimalToNumber('12.50', 2)).toBe(12.5);
    expect(decimalToText(12.5, 2)).toBe('12.50');
    expect(() => decimalToNumber('12345678901234567.89', 2)).toThrow(
      UnrepresentableDefinitionError,
    );
    expect(() => decimalToText(0.123, 2)).toThrow(UnrepresentableDefinitionError);
    expect(() => decimalToText(Number.NaN, 2)).toThrow(UnrepresentableDefinitionError);
  });
});

describe('servidor → interface', () => {
  it('uma entidade publicada com rascunho dá duas definições, com apresentação e versão de concorrência', () => {
    const detail: EntityDetailDto = {
      entity: entity({ version: 9 }),
      published: version([field()]),
      draft: version([field(), field({ code: 'cor', label: 'Cor', position: 1 })], {
        id: 'v2',
        revision: 2,
        publishedAt: null,
      }),
    };
    const [published, draft] = definitionsFromServer('t1', detail);
    expect(published).toMatchObject({
      key: 'ordem-servico',
      scope: 'tenant',
      tenantId: 't1',
      state: 'published',
      version: 1,
      id: 'v1',
      rowVersion: 9,
      names: { singular: 'Ordem de serviço', plural: 'Ordens de serviço' },
      icon: 'wrench',
      moduleId: null,
    });
    expect(draft).toMatchObject({ state: 'draft', version: 2, id: 'v2' });
    expect(draft!.fields.map((f) => f.key)).toEqual(['marca', 'cor']);
    // Sem estados nem fluxos no servidor (C13): nada é inventado.
    expect(published!.statuses).toEqual([]);
    expect(published!.workflow).toBeNull();
    expect(published!.permissions.operations).toMatchObject({
      read: 'dynamic.read',
      create: 'dynamic.create',
      update: 'dynamic.update',
      delete: 'dynamic.archive',
    });
  });

  it('uma entidade arquivada mostra a versão publicada como arquivada; só rascunho = só rascunho', () => {
    expect(
      definitionsFromServer('t1', {
        entity: entity({ status: 'ARCHIVED' }),
        published: version([field()]),
        draft: null,
      }).map((d) => d.state),
    ).toEqual(['archived']);
    expect(
      definitionsFromServer('t1', {
        entity: entity({ status: 'DRAFT', publishedVersion: null }),
        published: null,
        draft: version([field()], { publishedAt: null }),
      }).map((d) => d.state),
    ).toEqual(['draft']);
  });

  it('campos: texto com regras, apresentação e sensibilidade', () => {
    const f = fieldOf(
      field({
        code: 'matricula',
        label: 'Matrícula',
        required: true,
        validation: { maxLength: 12, minLength: 4, pattern: '^[A-Z]+$', unique: true },
        presentation: {
          description: 'Ajuda',
          placeholder: 'AB-12',
          searchable: true,
          sortable: true,
        },
        sensitive: true,
        readOnly: true,
      }),
    );
    expect(f).toMatchObject({
      type: 'text',
      key: 'matricula',
      required: true,
      description: 'Ajuda',
      placeholder: 'AB-12',
      searchable: true,
      filterable: false,
      sortable: true,
      editable: false,
      sensitivity: 'sensitive',
      permissions: { read: 'dynamic.sensitive', write: 'dynamic.sensitive' },
    });
    expect(f.validations).toEqual(
      expect.arrayContaining([
        { type: 'maxLength', value: 12 },
        { type: 'minLength', value: 4 },
        { type: 'pattern', pattern: '^[A-Z]+$' },
        { type: 'unique' },
      ]),
    );
  });

  it('decimais: escala, limites e valor por omissão como números', () => {
    const f = fieldOf(
      field({
        code: 'preco',
        type: 'DECIMAL',
        defaultValue: '10.50',
        validation: { precision: 15, scale: 2, min: '0.00', max: '999.99' },
      }),
    );
    expect(f).toMatchObject({ type: 'decimal', scale: 2, defaultValue: 10.5 });
    expect(f.validations).toEqual([
      { type: 'min', value: 0 },
      { type: 'max', value: 999.99 },
    ]);
    // A precisão não é editável na interface: viaja em serverValidation para não se perder.
    expect(f.serverValidation).toEqual({ precision: 15 });
  });

  it('fórmulas: a expressão volta a camelCase (as funções ficam) e a árvore do servidor não passa', () => {
    const f = fieldOf(
      field({
        code: 'total',
        type: 'FORMULA',
        readOnly: true,
        validation: {
          expression: 'round(preco_unitario * quantidade, 2) - max(desconto, 0)',
          scale: 2,
          ast: { kind: 'num' },
          dependencies: ['preco_unitario', 'quantidade', 'desconto'],
        },
      }),
    );
    expect(f).toMatchObject({
      type: 'formula',
      scale: 2,
      editable: false,
      formula: { source: 'round(precoUnitario * quantidade, 2) - max(desconto, 0)' },
    });
    expect(f.serverValidation).toBeUndefined();
  });

  it('uma fórmula sem expressão não se representa', () => {
    expect(() => fieldOf(field({ type: 'FORMULA', validation: { scale: 2 } }))).toThrow(
      UnrepresentableDefinitionError,
    );
  });

  it('opções arquivadas ficam inactivas; datas e selecções guardam o que a interface não edita', () => {
    const select = fieldOf(
      field({
        code: 'tipo',
        type: 'SELECT',
        options: [
          { code: 'car', label: 'Ligeiro' },
          { code: 'old', label: 'Antigo', archived: true },
        ],
      }),
    );
    expect(select).toMatchObject({
      type: 'select',
      options: [
        { value: 'car', label: 'Ligeiro' },
        { value: 'old', label: 'Antigo', active: false },
      ],
    });
    const date = fieldOf(
      field({ code: 'compra', type: 'DATE', validation: { min: '2020-01-01', unique: true } }),
    );
    expect(date.serverValidation).toEqual({ min: '2020-01-01' });
    expect(date.validations).toEqual([{ type: 'unique' }]);
    const multi = fieldOf(
      field({
        code: 'tags',
        type: 'MULTISELECT',
        validation: { maxSelected: 2 },
        options: [{ code: 'a', label: 'A' }],
      }),
    );
    expect(multi.serverValidation).toEqual({ maxSelected: 2 });
  });

  it('referências: o destino vem como código da entidade; sem ele a definição não se representa', () => {
    const f = fieldOf(
      field({ code: 'garagem', type: 'ENTITY_REFERENCE', referenceEntityCode: 'garagem_central' }),
    );
    expect(f).toMatchObject({ type: 'entity-reference', entityKey: 'garagem-central' });
    expect(() => fieldOf(field({ type: 'ENTITY_REFERENCE' }))).toThrow(
      UnrepresentableDefinitionError,
    );
    expect(fieldOf(field({ code: 'condutor', type: 'USER_REFERENCE' })).type).toBe(
      'user-reference',
    );
  });

  it('campos arquivados mantêm-se (valores antigos legíveis)', () => {
    expect(fieldOf(field({ archived: true })).archived).toBe(true);
  });
});

describe('interface → servidor', () => {
  const build = (input: Parameters<typeof defineField>[0]) => defineField(input);

  it('é o inverso de servidor → interface (sem perder regras nem apresentação)', () => {
    const original = field({
      code: 'preco_base',
      label: 'Preço',
      type: 'DECIMAL',
      required: true,
      defaultValue: '10.50',
      validation: { precision: 15, scale: 2, min: '0.00', max: '99.99' },
      presentation: { description: 'Sem IVA', filterable: true, sortable: true, searchable: false },
    });
    const { dto, issues } = toServer(fieldOf(original));
    expect(issues).toEqual([]);
    expect(dto).toEqual({
      code: 'preco_base',
      label: 'Preço',
      type: 'DECIMAL',
      required: true,
      defaultValue: '10.50',
      validation: { precision: 15, scale: 2, min: '0.00', max: '99.99' },
      sensitive: false,
      readOnly: false,
      presentation: { description: 'Sem IVA', searchable: false, filterable: true, sortable: true },
    } satisfies FieldInputDto);
  });

  it('opções inactivas saem do rascunho (a publicação arquiva-as)', () => {
    const f = build({
      type: 'select',
      key: 'tipo',
      label: 'Tipo',
      options: [
        { value: 'a', label: 'A' },
        { value: 'b', label: 'B', active: false },
      ],
    });
    expect(toServer(f).dto?.options).toEqual([{ code: 'a', label: 'A' }]);
  });

  it('decimais levam precisão 15 por omissão e a escala do campo', () => {
    const f = build({ type: 'decimal', key: 'peso', label: 'Peso', scale: 3 });
    expect(toServer(f).dto?.validation).toEqual({ precision: 15, scale: 3 });
  });

  it('fórmulas seguem como texto em snake_case, com a escala', () => {
    const f = build({
      type: 'formula',
      key: 'total',
      label: 'Total',
      scale: 2,
      formula: { source: 'round(precoUnitario * quantidade, 2)' },
    });
    const dto = toServer(f).dto;
    expect(dto).toMatchObject({ type: 'FORMULA', required: false, readOnly: true });
    expect(dto?.validation).toEqual({
      expression: 'round(preco_unitario * quantidade, 2)',
      scale: 2,
    });
  });

  it('tipos, condições e regras que o servidor ainda não tem são recusados, nunca descartados', () => {
    const currency = build({ type: 'currency', key: 'valor', label: 'Valor', currency: 'AOA' });
    expect(toServer(currency).dto).toBeNull();
    expect(toServer(currency).issues[0]?.message).toContain('ainda não está disponível');

    const conditional = build({
      type: 'text',
      key: 'nota',
      label: 'Nota',
      visibleWhen: { op: 'eq', field: 'a', value: 1 },
    });
    expect(toServer(conditional).dto).toBeNull();

    const compare = build({
      type: 'number',
      key: 'qtd',
      label: 'Qtd',
      validations: [{ type: 'compare', operator: 'gt', otherField: 'min' }],
    });
    expect(toServer(compare).issues).toHaveLength(1);

    const ignoreCase = build({
      type: 'text',
      key: 'cod',
      label: 'Cód',
      validations: [{ type: 'pattern', pattern: 'a', ignoreCase: true }],
    });
    expect(toServer(ignoreCase).issues).toHaveLength(1);
  });

  it('um campo sensível, só de leitura, com referência e valor por omissão', () => {
    const f = build({
      type: 'entity-reference',
      key: 'garagemCentral',
      label: 'Garagem',
      entityKey: 'garagem-central',
      sensitivity: 'sensitive',
      editable: false,
    });
    expect(toServer(f).dto).toMatchObject({
      code: 'garagem_central',
      type: 'ENTITY_REFERENCE',
      referenceEntityCode: 'garagem_central',
      sensitive: true,
      readOnly: true,
    });
  });
});

describe('registos', () => {
  const fields = [
    defineField({ type: 'text', key: 'matricula', label: 'Matrícula' }),
    defineField({ type: 'decimal', key: 'precoBase', label: 'Preço', scale: 2 }),
    defineField({ type: 'text', key: 'calculado', label: 'X', editable: false }),
    defineField({ type: 'text', key: 'velho', label: 'Velho', archived: true }),
    defineField({ type: 'multiselect', key: 'tags', label: 'Tags', options: [] }),
  ];

  it('os valores do servidor trazem chaves camelCase e decimais como número', () => {
    expect(
      recordDataFromServer(
        { matricula: 'AB', preco_base: '10.50', tags: ['a'] },
        fieldsByCode(fields),
      ),
    ).toEqual({ matricula: 'AB', precoBase: 10.5, tags: ['a'] });
  });

  it('um decimal que não cabe num número faz a leitura falhar em vez de se corromper', () => {
    expect(() =>
      recordDataFromServer({ preco_base: '99999999999999999.99' }, fieldsByCode(fields)),
    ).toThrow(UnrepresentableDefinitionError);
  });

  it('os valores para o servidor: snake_case, decimais em texto, vazios apagam, só campos escritáveis', () => {
    expect(
      recordDataToServer(
        {
          matricula: 'AB',
          precoBase: 10.5,
          calculado: 'x',
          velho: 'y',
          tags: [],
          desconhecido: '',
        },
        fields,
      ),
    ).toEqual({
      matricula: 'AB',
      preco_base: '10.50',
      tags: null,
      desconhecido: null,
    });
    expect(recordDataToServer({ matricula: '' }, fields)).toEqual({ matricula: null });
  });
});
