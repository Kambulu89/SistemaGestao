import { STATUS_KEY, type Condition } from '../models/condition.model';
import type { EntityDefinition } from '../models/entity-definition.model';
import type { FieldDefinition } from '../models/field-definition.model';
import type {
  FormColumns,
  FormDefinition,
  FormFieldItem,
  FormItem,
  FormMode,
} from '../models/form-definition.model';
import type { ValidationRule } from '../models/validation-rule.model';
import { conditionDepth, conditionFields, MAX_CONDITION_DEPTH } from './condition';
import { defaultSpecIssue } from './default-values';
import { FORM_RULE_TYPES, indexFormFields } from './form-config';
import { fieldCapabilities } from './field-types';
import { safeRegExp } from './validation';

/** Mesmo formato que `DefinitionIssue` (declarado em `definition-integrity`, que importa este módulo). */
export interface FormIssue {
  readonly severity: 'error' | 'warning';
  readonly path: string;
  readonly message: string;
}

export interface FormIntegrityOptions {
  /**
   * Formulários geridos têm regras mais exigentes (secção obrigatória, campos obrigatórios da
   * entidade presentes no formulário de criação, um só formulário por omissão por modo…).
   */
  readonly strict?: boolean;
  /** Os outros formulários publicados da mesma entidade e âmbito, para a regra de «por omissão». */
  readonly siblings?: readonly FormDefinition[];
}

const FORM_KEY = /^[a-z][a-z0-9-]{1,39}$/;
const SECTION_KEY = /^[a-z][a-zA-Z0-9-]{0,39}$/;
const MODES: readonly FormMode[] = ['create', 'edit', 'read'];
const TEXT_LIKE = new Set(['text', 'textarea', 'email', 'phone', 'url']);
const NUMERIC = new Set(['number', 'decimal', 'currency']);
const ORDERED = new Set([
  'number',
  'decimal',
  'currency',
  'date',
  'datetime',
  'formula',
  'auto-number',
]);
const NOT_WRITABLE = (f: FieldDefinition) => !fieldCapabilities(f.type).writable;

/**
 * Valida um formulário contra a entidade a que pertence. Não executa nada: só inspecciona
 * referências, tipos, condições e restrições. Um formulário com erros não pode ser publicado.
 */
export function validateFormDefinition(
  form: FormDefinition,
  entity: EntityDefinition,
  options: FormIntegrityOptions = {},
): FormIssue[] {
  const issues: FormIssue[] = [];
  const base = `forms.${form.key}`;
  const error = (path: string, message: string) =>
    issues.push({ severity: 'error', path, message });
  const warn = (path: string, message: string) =>
    issues.push({ severity: 'warning', path, message });
  const strict = options.strict === true;

  const fields = new Map(entity.fields.map((f) => [f.key, f]));
  const statusCodes = new Set(entity.statuses.map((s) => s.code));

  // --- identidade e modos
  if (strict && !FORM_KEY.test(form.key))
    error(base, 'O código começa por minúscula e tem 2 a 40 minúsculas, números ou hífens.');
  if (strict && !form.name.trim()) error(base, 'O formulário precisa de um nome.');
  if (form.modes.length === 0) error(base, 'O formulário não é usado em nenhum modo.');
  if (form.modes.some((m) => !MODES.includes(m))) error(base, 'Modo de formulário inválido.');
  if (new Set(form.modes).size !== form.modes.length) error(base, 'Há modos repetidos.');
  if (form.layout && form.layout.kind !== 'sections')
    error(base, 'Só o layout por secções está disponível.');
  if (strict && form.sections.length === 0)
    error(base, 'O formulário precisa de pelo menos uma secção.');

  // --- condições
  const checkCondition = (path: string, condition: Condition | undefined) => {
    if (!condition) return;
    if (conditionDepth(condition) > MAX_CONDITION_DEPTH)
      error(path, `A condição tem demasiados níveis (máx. ${MAX_CONDITION_DEPTH}).`);
    for (const key of conditionFields(condition)) {
      if (key === STATUS_KEY) {
        if (statusCodes.size === 0)
          error(path, 'A condição usa o estado, mas a entidade não tem estados.');
      } else if (!fields.has(key)) error(path, `A condição refere o campo desconhecido "${key}".`);
    }
    checkConditionTypes(path, condition, fields, error);
  };

  // --- secções
  const seenSections = new Set<string>();
  const seenFields = new Set<string>();
  form.sections.forEach((section, si) => {
    const sectionPath = `${base}.sections[${si}]`;
    if (!SECTION_KEY.test(section.key))
      error(sectionPath, `Chave de secção inválida "${section.key}".`);
    if (seenSections.has(section.key))
      error(sectionPath, `A secção "${section.key}" está repetida.`);
    seenSections.add(section.key);
    if (strict && !section.title.trim()) error(sectionPath, 'A secção precisa de um título.');
    if (![1, 2, 3, 4].includes(section.columns)) error(sectionPath, 'As colunas têm de ser 1 a 4.');
    if (section.collapsed && !section.collapsible)
      error(sectionPath, 'Só uma secção recolhível pode começar recolhida.');
    checkCondition(`${sectionPath}.visibleWhen`, section.visibleWhen);

    const visit = (items: readonly FormItem[], columns: FormColumns, path: string) =>
      items.forEach((item, i) => {
        if (item.kind === 'group')
          return visit(item.items, item.columns ?? columns, `${path}[${i}]`);
        const itemPath = `${path}[${i}]`;
        checkItem(item, columns, itemPath);
      });
    visit(section.items, section.columns, sectionPath);
  });

  function checkItem(item: FormFieldItem, columns: FormColumns, path: string): void {
    const field = fields.get(item.field);
    if (!field) {
      error(path, `O formulário refere o campo desconhecido "${item.field}".`);
      return;
    }
    if (seenFields.has(item.field)) error(path, `O campo "${item.field}" aparece mais de uma vez.`);
    seenFields.add(item.field);
    if (field.archived) error(path, `O campo "${item.field}" está arquivado.`);
    if (item.span !== undefined && item.span > columns)
      error(path, `A largura (${item.span}) excede as colunas da secção (${columns}).`);
    for (const [name, text] of [
      ['rótulo', item.label],
      ['texto de ajuda', item.help],
      ['placeholder', item.placeholder],
    ] as const)
      if (text !== undefined && text.length > 200)
        error(path, `O ${name} é demasiado longo (máx. 200).`);
    if (item.label !== undefined && !item.label.trim())
      error(path, 'O rótulo não pode ficar vazio.');

    checkCondition(`${path}.visibleWhen`, item.visibleWhen);
    checkCondition(`${path}.editableWhen`, item.editableWhen);
    checkCondition(`${path}.requiredWhen`, item.requiredWhen);
    checkCondition(`${path}.defaultWhen`, item.defaultWhen);

    // O formulário nunca relaxa a entidade.
    if (item.required === false && field.required)
      error(
        path,
        `"${field.label}" é obrigatório na entidade: o formulário não o pode tornar opcional.`,
      );
    if (NOT_WRITABLE(field)) {
      if (item.required)
        error(path, `"${field.label}" é atribuído pelo servidor e não pode ser obrigatório.`);
      if (item.defaultValue)
        error(path, `"${field.label}" é atribuído pelo servidor e não tem valor por omissão.`);
      if (item.validations?.length)
        error(path, `"${field.label}" é atribuído pelo servidor e não aceita validações.`);
    }

    // Valores por omissão.
    if (item.defaultWhen && !item.defaultValue)
      error(path, 'A condição do valor por omissão precisa de um valor.');
    if (item.defaultValue) {
      const problem = defaultSpecIssue(item.defaultValue, field);
      if (problem) error(path, problem);
    }

    // Campo que a entidade obriga a preencher mas que o utilizador não consegue preencher.
    if (field.required && !NOT_WRITABLE(field) && form.modes.includes('create')) {
      const canFill = item.visible !== false && item.editable !== false;
      const hasDefault = item.defaultValue !== undefined || field.defaultValue !== undefined;
      if (!canFill && !hasDefault)
        error(
          path,
          `"${field.label}" é obrigatório e fica escondido ou só de leitura na criação, sem valor por omissão.`,
        );
    }

    // Validações adicionais.
    item.validations?.forEach((rule, ri) =>
      checkFormRule(`${path}.validations[${ri}]`, rule, field),
    );
  }

  function checkFormRule(path: string, rule: ValidationRule, field: FieldDefinition): void {
    if (!FORM_RULE_TYPES.includes(rule.type)) {
      error(
        path,
        `A regra "${rule.type}" não se pode definir num formulário (só min, max, comprimentos, padrão e email).`,
      );
      return;
    }
    switch (rule.type) {
      case 'minLength':
      case 'maxLength':
        if (!TEXT_LIKE.has(field.type)) error(path, `${rule.type} só se aplica a campos de texto.`);
        if (!Number.isInteger(rule.value) || rule.value < 0)
          error(path, 'O limite tem de ser um inteiro ≥ 0.');
        break;
      case 'min':
      case 'max':
        if (!NUMERIC.has(field.type)) error(path, `${rule.type} só se aplica a campos numéricos.`);
        if (!Number.isFinite(rule.value)) error(path, 'O limite tem de ser um número.');
        break;
      case 'pattern':
        if (!TEXT_LIKE.has(field.type)) error(path, 'O padrão só se aplica a campos de texto.');
        else if (!safeRegExp(rule.pattern, rule.ignoreCase))
          error(path, 'Padrão inválido ou demasiado complexo.');
        break;
      case 'email':
        if (!TEXT_LIKE.has(field.type))
          error(path, 'A regra de email só se aplica a campos de texto.');
        break;
      default:
        break;
    }
  }

  // --- campos obrigatórios da entidade que o formulário de criação não inclui
  if (strict && form.modes.includes('create')) {
    const index = indexFormFields(form);
    for (const field of entity.fields) {
      if (field.archived || !field.required || NOT_WRITABLE(field) || index.has(field.key))
        continue;
      if (field.defaultValue === undefined)
        error(
          `${base}.sections`,
          `O campo obrigatório "${field.label}" não está no formulário de criação.`,
        );
    }
  }

  // --- dependências circulares entre condições de visibilidade e edição
  for (const cycle of conditionCycles(form)) {
    error(
      `${base}.conditions`,
      `Dependência circular entre as condições de: ${cycle.join(' → ')}.`,
    );
  }

  // --- só um formulário por omissão por modo (e âmbito)
  if (strict && form.isDefault) {
    for (const other of options.siblings ?? []) {
      if (other.key === form.key || !other.isDefault) continue;
      const clash = other.modes.filter((m) => form.modes.includes(m));
      if (clash.length > 0)
        error(
          base,
          `O formulário "${other.key}" já é o formulário por omissão em: ${clash.join(', ')}.`,
        );
    }
  }

  // Aviso: condições que dependem de campos que o formulário não mostra.
  const index = indexFormFields(form);
  for (const [key, { item }] of index) {
    for (const [name, c] of [
      ['visibleWhen', item.visibleWhen],
      ['editableWhen', item.editableWhen],
      ['requiredWhen', item.requiredWhen],
    ] as const) {
      if (!c) continue;
      for (const dep of conditionFields(c)) {
        if (dep !== STATUS_KEY && fields.has(dep) && !index.has(dep))
          warn(
            `${base}.${key}.${name}`,
            `A condição depende de "${dep}", que não está no formulário (vale sempre vazio).`,
          );
      }
    }
  }

  return issues;
}

/** Operadores e valores compatíveis com o tipo do campo referido. */
function checkConditionTypes(
  path: string,
  condition: Condition,
  fields: ReadonlyMap<string, FieldDefinition>,
  error: (path: string, message: string) => void,
): void {
  switch (condition.op) {
    case 'and':
    case 'or':
      condition.conditions.forEach((c) => checkConditionTypes(path, c, fields, error));
      return;
    case 'not':
      checkConditionTypes(path, condition.condition, fields, error);
      return;
    case 'empty':
    case 'notEmpty':
      return;
    default: {
      const field = fields.get(condition.field);
      if (!field) return; // já assinalado
      if (['gt', 'gte', 'lt', 'lte'].includes(condition.op) && !ORDERED.has(field.type))
        error(path, `O operador ${condition.op} não se aplica a "${field.label}" (${field.type}).`);
      const values = 'values' in condition ? condition.values : [condition.value];
      if ('options' in field) {
        const valid = new Set(field.options.map((o) => o.value));
        for (const v of values)
          if (typeof v === 'string' && !valid.has(v))
            error(path, `"${v}" não é uma opção de "${field.label}".`);
      }
    }
  }
}

/**
 * Ciclos no grafo «a visibilidade/edição de X depende do valor de Y». Um campo que depende de
 * si próprio também conta. Devolve cada ciclo como lista de chaves.
 */
export function conditionCycles(form: FormDefinition): string[][] {
  const index = indexFormFields(form);
  const deps = new Map<string, Set<string>>();
  for (const [key, { item, section }] of index) {
    const set = new Set<string>();
    for (const c of [item.visibleWhen, item.editableWhen, section.visibleWhen])
      if (c) for (const dep of conditionFields(c)) if (dep !== STATUS_KEY) set.add(dep);
    deps.set(key, set);
  }

  const cycles: string[][] = [];
  const state = new Map<string, 'visiting' | 'done'>();
  const reported = new Set<string>();
  const visit = (key: string, stack: string[]): void => {
    if (state.get(key) === 'done' || !deps.has(key)) return;
    if (state.get(key) === 'visiting') {
      const cycle = stack.slice(stack.indexOf(key));
      const id = [...cycle].sort().join('|');
      if (!reported.has(id)) {
        reported.add(id);
        cycles.push([...cycle, key]);
      }
      return;
    }
    state.set(key, 'visiting');
    for (const dep of deps.get(key)!) visit(dep, [...stack, key]);
    state.set(key, 'done');
  };
  for (const key of deps.keys()) visit(key, []);
  return cycles;
}

export const hasFormErrors = (issues: readonly FormIssue[]): boolean =>
  issues.some((i) => i.severity === 'error');
