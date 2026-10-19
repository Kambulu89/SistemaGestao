import { CADASTRO_CLIENTE, CLIENTE } from '../../testing/form-fixtures';
import { defaultSpecIssue, resolveDefaultValue, defaultContextAt } from './default-values';
import {
  andCondition,
  applyFormConfiguration,
  formDefaults,
  indexFormFields,
  orCondition,
} from './form-config';
import { resolveFieldState } from './field-state';
import { validateRecordData } from './validation';
import type { FormDefinition } from '../models/form-definition.model';

const field = (entity: typeof CLIENTE, key: string) => entity.fields.find((f) => f.key === key)!;
const withItems = (
  items: FormDefinition['sections'][number]['items'],
  extra: object = {},
): FormDefinition => ({
  ...CADASTRO_CLIENTE,
  sections: [{ key: 's', title: 'S', columns: 2, items, ...extra }],
});

describe('applyFormConfiguration', () => {
  it('aplica rótulo, placeholder e ajuda só neste formulário, sem tocar na entidade', () => {
    const form = withItems([
      {
        kind: 'field',
        field: 'nome',
        label: 'Nome completo',
        placeholder: 'Ex.: Ana Silva',
        help: 'Como no cartão',
      },
    ]);
    const effective = applyFormConfiguration(CLIENTE, form);
    expect(field(effective, 'nome')).toMatchObject({
      label: 'Nome completo',
      placeholder: 'Ex.: Ana Silva',
      description: 'Como no cartão',
    });
    expect(field(CLIENTE, 'nome').label).toBe('Nome'); // a definição original não muda
    expect(field(effective, 'nome').key).toBe('nome'); // o identificador é estável
  });

  it('esconde os campos que o formulário não inclui (não se validam nem se enviam)', () => {
    const effective = applyFormConfiguration(
      CLIENTE,
      withItems([{ kind: 'field', field: 'nome' }]),
    );
    expect(field(effective, 'nif').visible).toBe(false);
    expect(field(effective, 'nome').visible).toBe(true);
  });

  it('nunca relaxa a entidade: obrigatório continua obrigatório', () => {
    const effective = applyFormConfiguration(
      CLIENTE,
      withItems([{ kind: 'field', field: 'nome', required: false }]),
    );
    expect(field(effective, 'nome').required).toBe(true);
  });

  it('pode acrescentar obrigatoriedade, ocultação e só de leitura', () => {
    const effective = applyFormConfiguration(
      CLIENTE,
      withItems([
        { kind: 'field', field: 'nif', required: true },
        { kind: 'field', field: 'telefone', visible: false },
        { kind: 'field', field: 'segmento', editable: false },
      ]),
    );
    expect(field(effective, 'nif').required).toBe(true);
    expect(field(effective, 'telefone').visible).toBe(false);
    expect(field(effective, 'segmento').editable).toBe(false);
  });

  it('nunca mostra o que a entidade esconde', () => {
    const hidden = {
      ...CLIENTE,
      fields: CLIENTE.fields.map((f) => (f.key === 'nif' ? { ...f, visible: false } : f)),
    };
    const effective = applyFormConfiguration(
      hidden,
      withItems([{ kind: 'field', field: 'nif', visible: true }]),
    );
    expect(field(effective, 'nif').visible).toBe(false);
  });

  it('junta as condições do formulário às do campo (AND; a obrigatoriedade soma por OR)', () => {
    const entity = {
      ...CLIENTE,
      fields: CLIENTE.fields.map((f) =>
        f.key === 'nif'
          ? {
              ...f,
              visibleWhen: { op: 'notEmpty' as const, field: 'nome' },
              requiredWhen: { op: 'eq' as const, field: 'segmento', value: 'particular' },
            }
          : f,
      ),
    };
    const effective = applyFormConfiguration(
      entity,
      withItems([
        {
          kind: 'field',
          field: 'nif',
          visibleWhen: { op: 'eq', field: 'segmento', value: 'empresarial' },
          requiredWhen: { op: 'notEmpty', field: 'telefone' },
        },
      ]),
    );
    const nif = field(effective, 'nif');
    expect(nif.visibleWhen?.op).toBe('and');
    expect(nif.requiredWhen?.op).toBe('or');
    const state = (values: Record<string, string | null>) =>
      resolveFieldState(nif, { values, status: null }, 'create');
    expect(state({ nome: 'A', segmento: 'empresarial', telefone: null })).toMatchObject({
      visible: true,
      required: false,
    });
    expect(state({ nome: 'A', segmento: 'empresarial', telefone: '912345678' }).required).toBe(
      true,
    );
    expect(state({ nome: 'A', segmento: 'particular' }).visible).toBe(false);
  });

  it('a condição da secção esconde todos os seus campos', () => {
    const form = withItems(
      [
        { kind: 'field', field: 'nif' },
        { kind: 'field', field: 'telefone' },
      ],
      {
        visibleWhen: { op: 'eq', field: 'segmento', value: 'empresarial' },
      },
    );
    const effective = applyFormConfiguration(CLIENTE, form);
    for (const key of ['nif', 'telefone'])
      expect(
        resolveFieldState(
          field(effective, key),
          { values: { segmento: 'particular' }, status: null },
          'create',
        ).visible,
      ).toBe(false);
  });

  it('acrescenta validações do formulário e ignora as que um formulário não pode definir', () => {
    const form = withItems([
      {
        kind: 'field',
        field: 'nif',
        validations: [{ type: 'maxLength', value: 9 }, { type: 'unique' }],
      },
    ]);
    const nif = field(applyFormConfiguration(CLIENTE, form), 'nif');
    expect(nif.validations.map((r) => r.type)).toEqual(['maxLength']);
    const issues = validateRecordData(
      applyFormConfiguration(CLIENTE, form),
      { nome: 'A', nif: '1234567890' },
      { mode: 'create', status: null },
    );
    expect(issues.some((i) => i.fieldKey === 'nif' && i.rule === 'maxLength')).toBe(true);
  });

  it('o caso Cadastro de Cliente: o limite de crédito só aparece a clientes empresariais', () => {
    const effective = applyFormConfiguration(CLIENTE, CADASTRO_CLIENTE);
    const limite = field(effective, 'limiteCredito');
    const at = (segmento: string) =>
      resolveFieldState(limite, { values: { segmento }, status: null }, 'create').visible;
    expect(at('empresarial')).toBe(true);
    expect(at('particular')).toBe(false);
    expect(field(effective, 'numero').visible).toBe(false); // atribuído pelo servidor e fora do formulário
  });
});

describe('condições compostas', () => {
  it('andCondition/orCondition omitem ausentes e não embrulham uma só', () => {
    const a = { op: 'notEmpty' as const, field: 'x' };
    expect(andCondition()).toBeUndefined();
    expect(andCondition(undefined, a)).toBe(a);
    expect(orCondition(a, a)).toEqual({ op: 'or', conditions: [a, a] });
  });
});

describe('indexFormFields / formDefaults', () => {
  it('indexa campos também dentro de grupos e devolve a secção', () => {
    const form = withItems([
      { kind: 'group', items: [{ kind: 'field', field: 'nif' }] },
      { kind: 'field', field: 'nome' },
    ]);
    const index = indexFormFields(form);
    expect([...index.keys()]).toEqual(['nif', 'nome']);
    expect(index.get('nif')!.section.key).toBe('s');
  });

  it('recolhe só os campos com valor por omissão', () => {
    const form = withItems([
      { kind: 'field', field: 'segmento', defaultValue: { kind: 'fixed', value: 'particular' } },
      { kind: 'field', field: 'nome' },
    ]);
    expect([...formDefaults(form).keys()]).toEqual(['segmento']);
  });
});

describe('valores por omissão (lista fechada de resolvers)', () => {
  const context = defaultContextAt(
    new Date('2026-10-19T10:30:00Z'),
    { id: 'u1', name: 'Ana', email: 'a@x.pt' },
    { id: 't1', name: 'Escola' },
  );

  it('resolve data, momento, utilizador e tenant', () => {
    expect(resolveDefaultValue({ kind: 'today' }, context)).toBe('2026-10-19');
    expect(resolveDefaultValue({ kind: 'now' }, context)).toBe('2026-10-19T10:30:00.000Z');
    expect(resolveDefaultValue({ kind: 'currentUser', as: 'name' }, context)).toBe('Ana');
    expect(resolveDefaultValue({ kind: 'currentTenant', as: 'id' }, context)).toBe('t1');
    expect(resolveDefaultValue({ kind: 'fixed', value: 7 }, context)).toBe(7);
    expect(
      resolveDefaultValue({ kind: 'currentUser', as: 'id' }, { ...context, user: null }),
    ).toBeNull();
  });

  it('só aceita resolvers compatíveis com o tipo do campo', () => {
    const f = (key: string) => field(CLIENTE, key);
    expect(defaultSpecIssue({ kind: 'fixed', value: 'particular' }, f('segmento'))).toBeNull();
    expect(defaultSpecIssue({ kind: 'fixed', value: 'antigo' }, f('segmento'))).toContain(
      'opções activas',
    );
    expect(defaultSpecIssue({ kind: 'fixed', value: 'x' }, f('limiteCredito'))).toContain(
      'não é válido',
    );
    expect(defaultSpecIssue({ kind: 'fixed', value: 100 }, f('limiteCredito'))).toBeNull();
    expect(defaultSpecIssue({ kind: 'today' }, f('nome'))).toContain('data');
    expect(defaultSpecIssue({ kind: 'currentUser', as: 'name' }, f('nome'))).toBeNull();
    expect(defaultSpecIssue({ kind: 'currentTenant', as: 'name' }, f('limiteCredito'))).toContain(
      'texto',
    );
    expect(defaultSpecIssue({ kind: 'fixed', value: 'C-1' }, f('numero'))).toContain('servidor');
  });
});
