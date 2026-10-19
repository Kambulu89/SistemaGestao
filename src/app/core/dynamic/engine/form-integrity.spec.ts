import type { FormDefinition } from '../models/form-definition.model';
import { CADASTRO_CLIENTE, CLIENTE } from '../../testing/form-fixtures';
import { defineEntity } from './define-entity';
import { checkFormPublishable, diffForms } from './form-compat';
import { conditionCycles, hasFormErrors, validateFormDefinition } from './form-integrity';

const make = (
  sections: FormDefinition['sections'],
  extra: Partial<FormDefinition> = {},
): FormDefinition => ({
  ...CADASTRO_CLIENTE,
  sections,
  ...extra,
});
const sec = (items: FormDefinition['sections'][number]['items'], extra: object = {}) => ({
  key: 's',
  title: 'S',
  columns: 2 as const,
  items,
  ...extra,
});
const errors = (form: FormDefinition, strict = true) =>
  validateFormDefinition(form, CLIENTE, { strict })
    .filter((i) => i.severity === 'error')
    .map((i) => i.message);
const field = (f: string, extra: object = {}) => ({ kind: 'field' as const, field: f, ...extra });

describe('integridade de formulários', () => {
  it('o Cadastro de Cliente é válido', () => {
    expect(errors(CADASTRO_CLIENTE)).toEqual([]);
  });

  it('o motor é genérico: o mesmo contrato valida qualquer entidade', () => {
    const aluno = defineEntity({
      key: 'aluno',
      scope: 'tenant',
      tenantId: 't',
      names: { singular: 'Aluno', plural: 'Alunos' },
      icon: 'academic',
      fields: [
        { type: 'text', key: 'nome', label: 'Nome', required: true },
        { type: 'date', key: 'nascimento', label: 'Nascimento' },
      ],
    });
    const form: FormDefinition = {
      key: 'matricula',
      name: 'Matrícula',
      modes: ['create'],
      sections: [sec([field('nome'), field('nascimento', { defaultValue: { kind: 'today' } })])],
    };
    expect(validateFormDefinition(form, aluno, { strict: true })).toEqual([]);
    expect(
      validateFormDefinition({ ...form, sections: [sec([field('nascimento')])] }, aluno, {
        strict: true,
      })[0]!.message,
    ).toContain('não está no formulário de criação');
  });

  it('rejeita campos desconhecidos, repetidos e arquivados', () => {
    expect(errors(make([sec([field('fantasma')])])).join()).toContain(
      'campo desconhecido "fantasma"',
    );
    expect(errors(make([sec([field('nome'), field('nome')])])).join()).toContain('mais de uma vez');
    const archived = {
      ...CLIENTE,
      fields: CLIENTE.fields.map((f) => (f.key === 'nif' ? { ...f, archived: true } : f)),
    };
    const issues = validateFormDefinition(make([sec([field('nome'), field('nif')])]), archived, {
      strict: true,
    });
    expect(issues.map((i) => i.message).join()).toContain('arquivado');
  });

  it('valida secções: chaves únicas, colunas, largura, título', () => {
    expect(errors(make([sec([field('nome')]), sec([field('nif')])])).join()).toContain('repetida');
    expect(errors(make([sec([field('nome', { span: 3 })])])).join()).toContain('excede as colunas');
    expect(errors(make([sec([field('nome')], { title: ' ' })])).join()).toContain('título');
    expect(errors(make([sec([field('nome')], { collapsed: true })])).join()).toContain(
      'recolhível',
    );
    expect(errors(make([]), true).join()).toContain('pelo menos uma secção');
  });

  it('o formulário nunca relaxa a entidade', () => {
    expect(errors(make([sec([field('nome', { required: false })])])).join()).toContain(
      'não o pode tornar opcional',
    );
  });

  it('um campo obrigatório não pode ficar escondido ou bloqueado na criação sem valor por omissão', () => {
    expect(errors(make([sec([field('nome', { visible: false })])])).join()).toContain(
      'escondido ou só de leitura',
    );
    expect(errors(make([sec([field('nome', { editable: false })])])).join()).toContain(
      'escondido ou só de leitura',
    );
    expect(
      errors(
        make([
          sec([field('nome', { visible: false, defaultValue: { kind: 'fixed', value: 'X' } })]),
        ]),
      ),
    ).toEqual([]);
    // Na edição já existe valor: esconder é admissível.
    expect(
      errors(make([sec([field('nome', { visible: false })])], { modes: ['edit'] }), true),
    ).toEqual([]);
  });

  it('o formulário de criação inclui os campos obrigatórios da entidade', () => {
    expect(errors(make([sec([field('nif')])])).join()).toContain(
      '"Nome" não está no formulário de criação',
    );
    expect(errors(make([sec([field('nif')])], { modes: ['read'] }))).toEqual([]);
  });

  it('só se aceitam validações que apertam, aplicáveis ao tipo', () => {
    const bad = (item: object) => errors(make([sec([field('nome'), field('nif', item)])]));
    expect(bad({ validations: [{ type: 'unique' }] }).join()).toContain(
      'não se pode definir num formulário',
    );
    expect(bad({ validations: [{ type: 'min', value: 1 }] }).join()).toContain(
      'só se aplica a campos numéricos',
    );
    expect(bad({ validations: [{ type: 'maxLength', value: -1 }] }).join()).toContain(
      'inteiro ≥ 0',
    );
    expect(bad({ validations: [{ type: 'pattern', pattern: '(a+)+$' }] }).join()).toContain(
      'Padrão inválido',
    );
    expect(
      bad({
        validations: [
          { type: 'pattern', pattern: '^[0-9]{9}$' },
          { type: 'maxLength', value: 9 },
        ],
      }),
    ).toEqual([]);
  });

  it('campos atribuídos pelo servidor não são obrigatórios nem têm valor por omissão', () => {
    const problems = errors(
      make([
        sec([
          field('nome'),
          field('numero', { required: true, defaultValue: { kind: 'fixed', value: 'x' } }),
        ]),
      ]),
    );
    expect(problems.join()).toContain('não pode ser obrigatório');
    expect(problems.join()).toContain('não tem valor por omissão');
  });

  it('valida os valores por omissão e a sua condição', () => {
    const item = (extra: object) =>
      errors(make([sec([field('nome'), field('segmento', extra)])])).join();
    expect(item({ defaultValue: { kind: 'fixed', value: 'inexistente' } })).toContain(
      'opções activas',
    );
    expect(item({ defaultWhen: { op: 'notEmpty', field: 'nome' } })).toContain(
      'precisa de um valor',
    );
    expect(
      item({
        defaultValue: { kind: 'fixed', value: 'particular' },
        defaultWhen: { op: 'notEmpty', field: 'nome' },
      }),
    ).toBe('');
  });

  it('detecta referências inválidas e operadores incompatíveis nas condições', () => {
    const cond = (c: object) =>
      errors(make([sec([field('nome'), field('nif', { visibleWhen: c })])])).join();
    expect(cond({ op: 'eq', field: 'fantasma', value: 1 })).toContain(
      'campo desconhecido "fantasma"',
    );
    expect(cond({ op: 'eq', field: 'segmento', value: 'inexistente' })).toContain(
      'não é uma opção',
    );
    expect(cond({ op: 'gt', field: 'nome', value: 3 })).toContain('não se aplica');
    expect(cond({ op: 'in', field: 'segmento', values: ['particular', 'x'] })).toContain(
      'não é uma opção',
    );
    expect(cond({ op: 'eq', field: 'segmento', value: 'particular' })).toBe('');
    expect(cond({ op: 'gt', field: 'limiteCredito', value: 100000 })).toBe('');
  });

  it('limita a profundidade das condições compostas', () => {
    let c: object = { op: 'empty', field: 'nome' };
    for (let i = 0; i < 10; i++) c = { op: 'not', condition: c };
    expect(errors(make([sec([field('nome'), field('nif', { visibleWhen: c })])])).join()).toContain(
      'demasiados níveis',
    );
  });

  it('assinala dependências circulares entre condições, directas ou indirectas', () => {
    const a = field('nif', { visibleWhen: { op: 'notEmpty', field: 'telefone' } });
    const b = field('telefone', { visibleWhen: { op: 'notEmpty', field: 'nif' } });
    const form = make([sec([field('nome'), a, b])]);
    expect(conditionCycles(form)).toHaveLength(1);
    expect(errors(form).join()).toContain('Dependência circular');
    const self = make([
      sec([field('nome'), field('nif', { visibleWhen: { op: 'empty', field: 'nif' } })]),
    ]);
    expect(errors(self).join()).toContain('Dependência circular');
    const viaSection = make([
      sec([field('nome'), field('nif')], { visibleWhen: { op: 'notEmpty', field: 'telefone' } }),
      { ...sec([field('telefone', { visibleWhen: { op: 'notEmpty', field: 'nif' } })]), key: 'b' },
    ]);
    expect(conditionCycles(viaSection)).toHaveLength(1);
    expect(conditionCycles(CADASTRO_CLIENTE)).toEqual([]);
  });

  it('avisa quando uma condição depende de um campo que o formulário não mostra', () => {
    const form = make([
      sec([
        field('nome'),
        field('nif', { visibleWhen: { op: 'eq', field: 'segmento', value: 'particular' } }),
      ]),
    ]);
    const warnings = validateFormDefinition(form, CLIENTE, { strict: true }).filter(
      (i) => i.severity === 'warning',
    );
    expect(warnings[0]!.message).toContain('não está no formulário');
  });

  it('só um formulário por omissão por modo', () => {
    const other = { ...CADASTRO_CLIENTE, key: 'outro', isDefault: true };
    const mine = { ...CADASTRO_CLIENTE, isDefault: true };
    const issues = validateFormDefinition(mine, CLIENTE, { strict: true, siblings: [other] });
    expect(issues.map((i) => i.message).join()).toContain('já é o formulário por omissão');
    expect(
      validateFormDefinition({ ...mine, modes: ['edit'] }, CLIENTE, {
        siblings: [other],
        strict: true,
      })
        .filter((i) => i.severity === 'error')
        .map((i) => i.message)
        .join(),
    ).not.toContain('por omissão em');
  });

  it('a validação não estrita (formulários embutidos) mantém as regras estruturais', () => {
    expect(errors(make([sec([field('fantasma')])]), false).join()).toContain('desconhecido');
    expect(errors(make([sec([field('nif')])]), false)).toEqual([]);
  });
});

describe('ciclo de vida e compatibilidade de formulários', () => {
  const published = (extra: Partial<FormDefinition> = {}): FormDefinition => ({
    ...CADASTRO_CLIENTE,
    id: 'cliente@t-a#cadastro-cliente:v1',
    entityKey: 'cliente',
    scope: 'tenant',
    tenantId: 't-a',
    version: 1,
    state: 'published',
    ...extra,
  });
  const draftOf = (base: FormDefinition, extra: Partial<FormDefinition> = {}): FormDefinition => ({
    ...base,
    version: (base.version ?? 0) + 1,
    state: 'draft',
    ...extra,
  });

  it('uma definição válida e em rascunho pode publicar-se', () => {
    const check = checkFormPublishable(null, draftOf(published(), { version: 1 }), CLIENTE);
    expect(check.ok).toBe(true);
  });

  it('um formulário já publicado, ou inválido, não passa na verificação', () => {
    expect(checkFormPublishable(null, published(), CLIENTE).ok).toBe(false);
    const broken = draftOf(published(), { sections: [sec([field('fantasma')])] });
    const check = checkFormPublishable(published(), broken, CLIENTE);
    expect(check.ok).toBe(false);
    expect(hasFormErrors(check.issues)).toBe(true);
  });

  it('classifica as alterações entre versões', () => {
    const next = draftOf(published(), {
      modes: ['create', 'edit'],
      sections: [
        sec([field('nome', { label: 'Nome completo' }), field('telefone', { required: true })]),
      ],
    });
    const messages = diffForms(published(), next).map((c) => `${c.severity}:${c.message}`);
    expect(messages.some((m) => m.startsWith('warning:O campo "nif" deixa de aparecer'))).toBe(
      true,
    );
    expect(messages.some((m) => m.startsWith('warning:"telefone" passa a obrigatório'))).toBe(true);
    expect(messages.some((m) => m.startsWith('safe:Rótulo alterado'))).toBe(true);
    expect(messages.some((m) => m.startsWith('safe:O formulário passa a ser usado em: edit'))).toBe(
      true,
    );
  });

  it('mudar de entidade ou de código é destrutivo e bloqueia a publicação', () => {
    const moved = draftOf(published(), { entityKey: 'outra' });
    expect(diffForms(published(), moved).some((c) => c.severity === 'breaking')).toBe(true);
    expect(checkFormPublishable(published(), moved, CLIENTE).ok).toBe(false);
    expect(
      diffForms(published(), draftOf(published(), { key: 'novo-codigo' })).some(
        (c) => c.severity === 'breaking',
      ),
    ).toBe(true);
  });
});
