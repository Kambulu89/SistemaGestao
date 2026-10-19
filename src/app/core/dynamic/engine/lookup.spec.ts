import { defineEntity, defineField, type FieldInput } from './define-entity';
import { integrityContext, validateEntityDefinition } from './definition-integrity';
import { formatFieldValue } from './format-value';
import { resolveLookupSources } from './lookup-source';

const VIATURA = defineEntity({
  key: 'viatura',
  scope: 'tenant',
  tenantId: 't',
  names: { singular: 'Viatura', plural: 'Viaturas' },
  icon: 'cube',
  fields: [
    { type: 'text', key: 'matricula', label: 'Matrícula' },
    { type: 'date', key: 'seguroAte', label: 'Seguro até' },
    {
      type: 'multiselect',
      key: 'etiquetas',
      label: 'Etiquetas',
      options: [{ value: 'a', label: 'A' }],
    },
    {
      type: 'currency',
      key: 'custo',
      label: 'Custo',
      currency: 'EUR',
      sensitivity: 'sensitive',
      permissions: { read: 'v.custo.read', write: 'v.custo.write' },
    },
    { type: 'text', key: 'antigo', label: 'Antigo', archived: true },
  ],
});

const lookup = (relationField: string, sourceField: string, extra: object = {}): FieldInput => ({
  type: 'lookup',
  key: 'valor',
  label: 'Valor',
  lookup: { relationField, sourceField, onMissing: 'empty' },
  ...extra,
});

function tarefa(fields: FieldInput[]) {
  return defineEntity({
    key: 'tarefa',
    scope: 'tenant',
    tenantId: 't',
    names: { singular: 'Tarefa', plural: 'Tarefas' },
    icon: 'cube',
    fields: [
      { type: 'text', key: 'titulo', label: 'Título' },
      { type: 'entity-reference', key: 'viatura', label: 'Viatura', entityKey: 'viatura' },
      ...fields,
    ],
  });
}
const errors = (entity: ReturnType<typeof tarefa>) =>
  validateEntityDefinition(entity, integrityContext([entity, VIATURA]))
    .filter((i) => i.severity === 'error')
    .map((i) => i.message);

describe('integridade dos valores relacionados', () => {
  it('aceita uma relação válida', () => {
    expect(errors(tarefa([lookup('viatura', 'matricula')]))).toEqual([]);
  });

  it('exige que a relação seja uma referência existente a entidade', () => {
    expect(errors(tarefa([lookup('fantasma', 'matricula')])).join()).toContain('não existe');
    expect(errors(tarefa([lookup('titulo', 'matricula')])).join()).toContain(
      'não é uma referência',
    );
  });

  it('exige que o campo de origem exista, não esteja arquivado e seja escalar', () => {
    expect(errors(tarefa([lookup('viatura', 'inexistente')])).join()).toContain(
      'não existe em Viaturas',
    );
    expect(errors(tarefa([lookup('viatura', 'antigo')])).join()).toContain(
      'não existe em Viaturas',
    );
    expect(errors(tarefa([lookup('viatura', 'etiquetas')])).join()).toContain('multiselect');
  });

  it('não admite cadeias: um valor relacionado não pode ser a origem de outro', () => {
    const vistaComLookup = defineEntity({
      ...VIATURA,
      fields: [
        ...VIATURA.fields,
        defineField({
          type: 'lookup',
          key: 'x',
          label: 'X',
          lookup: { relationField: 'matricula', sourceField: 'matricula', onMissing: 'empty' },
        }),
      ],
    } as never);
    const entity = tarefa([lookup('viatura', 'x')]);
    const issues = validateEntityDefinition(entity, integrityContext([entity, vistaComLookup]));
    expect(issues.some((i) => i.severity === 'error')).toBe(true);
  });

  it('um campo sensível de origem exige um valor relacionado sensível com a mesma permissão', () => {
    expect(errors(tarefa([lookup('viatura', 'custo')])).join()).toContain('é sensível');
    expect(
      errors(
        tarefa([
          lookup('viatura', 'custo', {
            sensitivity: 'sensitive',
            permissions: { read: 'outra.read', write: 'outra.write' },
          }),
        ]),
      ).join(),
    ).toContain('mesma permissão');
    expect(
      errors(
        tarefa([
          lookup('viatura', 'custo', {
            sensitivity: 'sensitive',
            permissions: { read: 'v.custo.read', write: 'v.custo.write' },
          }),
        ]),
      ),
    ).toEqual([]);
  });

  it('não pode ser obrigatório', () => {
    expect(errors(tarefa([lookup('viatura', 'matricula', { required: true })])).join()).toContain(
      'não pode ser obrigatório',
    );
  });
});

describe('apresentação dos valores relacionados', () => {
  it('formata o valor como o campo de origem (data, moeda…)', () => {
    const [entity] = resolveLookupSources([tarefa([lookup('viatura', 'seguroAte')]), VIATURA]);
    const field = entity!.fields.find((f) => f.key === 'valor')!;
    expect(formatFieldValue(field, '2026-12-31', 'pt-PT')).toBe(
      formatFieldValue(
        VIATURA.fields.find((f) => f.key === 'seguroAte')!,
        '2026-12-31',
        'pt-PT',
      ),
    );
    expect(formatFieldValue(field, null)).toBe('—');
  });

  it('sem origem resolvida mostra o valor em bruto', () => {
    const field = defineField(lookup('viatura', 'matricula'));
    expect(formatFieldValue(field, 'AA-11-BB')).toBe('AA-11-BB');
    expect(formatFieldValue(field, true)).toBe('Sim');
  });

  it('não altera as definições de origem nem as que não têm valores relacionados', () => {
    const plain = tarefa([]);
    const [a, b] = resolveLookupSources([plain, VIATURA]);
    expect(a).toBe(plain);
    expect(b).toBe(VIATURA);
  });
});

describe('moeda com precisão própria', () => {
  it('mostra todas as casas decimais configuradas', () => {
    const field = defineField({
      type: 'currency',
      key: 'p',
      label: 'P',
      currency: 'EUR',
      scale: 4,
    });
    expect(formatFieldValue(field, 1.2345, 'pt-PT').replace(/\s/g, ' ')).toContain('1,2345');
    const zero = defineField({ type: 'currency', key: 'p', label: 'P', currency: 'EUR', scale: 0 });
    expect(formatFieldValue(zero, 12, 'pt-PT')).not.toContain(',');
  });
});
