import type { Condition } from '../models/condition.model';
import { STATUS_KEY } from '../models/condition.model';
import { SYSTEM_COLUMNS, type EntityDefinition } from '../models/entity-definition.model';
import { activeOptions, hasOptions, type FieldDefinition } from '../models/field-definition.model';
import { validateAutoNumber } from './auto-number';
import { orderFormulas, parseFormula } from './formula';
import { fieldCapabilities, isKnownFieldType } from './field-types';
import type { FormItem } from '../models/form-definition.model';
import type { ValidationRule } from '../models/validation-rule.model';
import { conditionDepth, conditionFields, MAX_CONDITION_DEPTH } from './condition';
import { ENTITY_OPERATIONS } from './entity-permissions';
import { isMimePattern, safeRegExp } from './validation';

export interface DefinitionIssue {
  readonly severity: 'error' | 'warning';
  /** Localização lógica, ex.: `fields.matricula.validations[0]`. */
  readonly path: string;
  readonly message: string;
}

/**
 * Contexto para validar referências entre entidades: as chaves existentes e, para os valores
 * relacionados (`lookup`), as próprias definições (para verificar o campo de origem).
 */
/** Tipos cujo valor pode ser copiado para um campo `lookup` (escalares legíveis). */
export const LOOKUP_SOURCE_TYPES: ReadonlySet<string> = new Set([
  'text',
  'textarea',
  'number',
  'decimal',
  'currency',
  'boolean',
  'checkbox',
  'date',
  'datetime',
  'email',
  'phone',
  'url',
  'select',
  'radio',
  'formula',
  'auto-number',
]);

export function integrityContext(entities: readonly EntityDefinition[]): IntegrityOptions {
  return {
    knownEntityKeys: new Set(entities.map((e) => e.key)),
    entities: new Map(entities.map((e) => [e.key, e])),
  };
}

export interface IntegrityOptions {
  /** Definições das entidades existentes, para validar campos `lookup`. */
  readonly entities?: ReadonlyMap<string, EntityDefinition>;
  /** Chaves de entidades existentes, para validar campos `reference`. */
  readonly knownEntityKeys?: ReadonlySet<string>;
}

const MAX_FILE_BYTES = 50 * 1024 * 1024;
const ENTITY_KEY = /^[a-z][a-z0-9-]*$/;
const FIELD_KEY = /^[a-z][a-zA-Z0-9]*$/;
const CODE = /^[a-z][a-z0-9_-]*$/;
/** Chaves reservadas pelo sistema: não podem ser campos. */
export const RESERVED_FIELD_KEYS: ReadonlySet<string> = new Set([
  'id',
  'status',
  'createdAt',
  'updatedAt',
  'rowVersion',
]);

/**
 * Valida a integridade dos metadados de uma definição. Não executa nada: só inspecciona
 * referências, formatos e limites. Uma definição com erros não pode ser publicada.
 */
export function validateEntityDefinition(
  entity: EntityDefinition,
  options: IntegrityOptions = {},
): DefinitionIssue[] {
  const issues: DefinitionIssue[] = [];
  const error = (path: string, message: string) =>
    issues.push({ severity: 'error', path, message });
  const warn = (path: string, message: string) =>
    issues.push({ severity: 'warning', path, message });

  const fieldKeys = new Set(entity.fields.map((f) => f.key));
  const statusCodes = new Set(entity.statuses.map((s) => s.code));
  const fieldByKey = new Map(entity.fields.map((f) => [f.key, f]));

  const NUMERIC = new Set(['number', 'decimal', 'currency', 'formula']);
  const cyclic = orderFormulas(entity.fields).cyclic;

  /** Valida uma fórmula: sintaxe, referências, tipos, ciclos, moedas e dados sensíveis. */
  const checkFormula = (field: Extract<FieldDefinition, { type: 'formula' }>): void => {
    const path = `fields.${field.key}`;
    if (!Number.isInteger(field.scale) || field.scale < 0 || field.scale > 10)
      error(path, 'As casas decimais do resultado têm de ser um inteiro entre 0 e 10.');
    const parsed = parseFormula(field.formula.source);
    if (!parsed.ok) {
      error(path, `Fórmula inválida: ${parsed.message}`);
      return;
    }
    const currencies = new Set<string>();
    for (const ref of parsed.refs) {
      const target = fieldByKey.get(ref);
      if (ref === field.key) continue; // o ciclo é assinalado abaixo
      if (!target) error(path, `A fórmula refere o campo desconhecido "${ref}".`);
      else if (target.archived) error(path, `A fórmula refere o campo arquivado "${ref}".`);
      else if (!NUMERIC.has(target.type))
        error(path, `A fórmula só aceita campos numéricos; "${ref}" é do tipo ${target.type}.`);
      else {
        if (target.type === 'currency') currencies.add(target.currency);
        // O resultado não pode revelar o que o utilizador não pode ler.
        if (
          target.sensitivity === 'sensitive' &&
          (field.sensitivity !== 'sensitive' ||
            field.permissions?.read !== target.permissions?.read)
        )
          error(
            path,
            `A fórmula usa o campo sensível "${ref}": tem de ser sensível e exigir a mesma permissão de leitura.`,
          );
      }
    }
    if (currencies.size > 1)
      error(path, `A fórmula mistura moedas diferentes (${[...currencies].join(', ')}).`);
    if (cyclic.has(field.key))
      error(
        path,
        'Dependência circular: a fórmula depende, directa ou indirectamente, de si própria.',
      );
  };

  /** Valida um valor relacionado: relação, entidade e campo de origem, e dados sensíveis. */
  const checkLookup = (field: Extract<FieldDefinition, { type: 'lookup' }>): void => {
    const path = `fields.${field.key}`;
    const relation = fieldByKey.get(field.lookup.relationField);
    if (!relation || relation.archived)
      return void error(path, `O campo de relação "${field.lookup.relationField}" não existe.`);
    if (relation.type !== 'entity-reference')
      return void error(path, `"${relation.key}" não é uma referência a entidade.`);
    if (!['empty', 'error'].includes(field.lookup.onMissing))
      error(path, 'Indique o que fazer quando o registo referenciado não existe.');
    // Sem definições do alvo (ex.: validação isolada) só se verifica a relação.
    const target = options.entities?.get(relation.entityKey);
    if (!options.entities) return;
    if (!target)
      return void error(path, `A entidade referenciada "${relation.entityKey}" não existe.`);
    const source = target.fields.find((f) => f.key === field.lookup.sourceField);
    if (!source || source.archived)
      return void error(
        path,
        `O campo "${field.lookup.sourceField}" não existe em ${target.names.plural}.`,
      );
    if (!LOOKUP_SOURCE_TYPES.has(source.type))
      return void error(
        path,
        `Não se pode mostrar um campo do tipo ${source.type} como valor relacionado.`,
      );
    if (
      source.sensitivity === 'sensitive' &&
      (field.sensitivity !== 'sensitive' || field.permissions?.read !== source.permissions?.read)
    )
      error(
        path,
        `O campo "${source.key}" é sensível: o valor relacionado tem de ser sensível e exigir a mesma permissão de leitura.`,
      );
  };

  // --- identidade
  if (!ENTITY_KEY.test(entity.key))
    error('key', `Chave inválida "${entity.key}" (use minúsculas, números e hífen).`);
  if (!Number.isInteger(entity.version) || entity.version < 1)
    error('version', 'A versão tem de ser um inteiro ≥ 1.');
  if (entity.scope === 'global' && entity.tenantId !== null)
    error('tenantId', 'Uma entidade global não tem tenant proprietário.');
  if (entity.scope === 'tenant' && !entity.tenantId)
    error('tenantId', 'Uma entidade de tenant tem de indicar o tenant proprietário.');
  if (!entity.names.singular.trim() || !entity.names.plural.trim())
    error('names', 'Indique o nome no singular e no plural.');
  if (entity.fields.length === 0) error('fields', 'A entidade precisa de pelo menos um campo.');

  // --- campos
  const seen = new Set<string>();
  for (const field of entity.fields) {
    const path = `fields.${field.key}`;
    if (!FIELD_KEY.test(field.key))
      error(path, `Chave de campo inválida "${field.key}" (use camelCase).`);
    if (RESERVED_FIELD_KEYS.has(field.key))
      error(path, `"${field.key}" é uma chave reservada pelo sistema.`);
    if (seen.has(field.key)) error(path, 'Chave de campo duplicada.');
    seen.add(field.key);
    if (!field.label.trim()) error(path, 'O campo precisa de um rótulo.');

    if (!isKnownFieldType(field.type)) error(path, `Tipo de campo desconhecido "${field.type}".`);

    // O tipo decide o que o campo pode fazer (pesquisar, ordenar, ter valor por omissão…).
    const caps = fieldCapabilities(field.type);
    if (field.defaultValue !== undefined && !caps.defaultValue)
      error(path, `O tipo "${field.type}" não admite valor por omissão.`);
    if (field.required && !caps.required)
      error(path, `O tipo "${field.type}" não pode ser obrigatório.`);
    if (field.searchable && !caps.searchable)
      error(path, `O tipo "${field.type}" não suporta pesquisa.`);
    if (field.filterable && !caps.filterable)
      error(path, `O tipo "${field.type}" não suporta filtro.`);
    if (field.sortable && !caps.sortable)
      error(path, `O tipo "${field.type}" não suporta ordenação.`);
    if (
      field.sensitivity === 'sensitive' &&
      !(field.permissions?.read && field.permissions?.write)
    ) {
      error(path, 'Dados sensíveis exigem permissões explícitas de leitura e de escrita.');
    }

    if (hasOptions(field)) {
      if (field.options.length === 0) error(path, 'Indique pelo menos uma opção.');
      const values = field.options.map((o) => o.value);
      if (new Set(values).size !== values.length) error(path, 'Há opções com o mesmo valor.');
      if (values.some((v) => !v.trim())) error(path, 'Há opções sem valor.');
      const defaults =
        field.type === 'multiselect'
          ? (field.defaultValue ?? [])
          : field.defaultValue
            ? [field.defaultValue]
            : [];
      if (defaults.some((d) => !values.includes(d)))
        error(path, 'O valor por omissão não é uma das opções.');
      if (field.options.length > 0 && activeOptions(field).length === 0)
        error(path, 'Tem de haver pelo menos uma opção activa.');
      const inactive = new Set(field.options.filter((o) => o.active === false).map((o) => o.value));
      if (defaults.some((d) => inactive.has(d)))
        error(path, 'O valor por omissão é uma opção inactiva.');
    }
    if (field.type === 'entity-reference') {
      if (!field.entityKey) error(path, 'Indique a entidade referenciada.');
      else if (options.knownEntityKeys && !options.knownEntityKeys.has(field.entityKey)) {
        error(path, `A entidade referenciada "${field.entityKey}" não existe.`);
      }
    }
    if (field.type === 'currency') {
      if (!/^[A-Z]{3}$/.test(field.currency)) error(path, 'Indique uma moeda ISO 4217 (ex.: EUR).');
      if (
        field.scale !== undefined &&
        !(Number.isInteger(field.scale) && field.scale >= 0 && field.scale <= 6)
      )
        error(path, 'A precisão da moeda tem de ser um inteiro entre 0 e 6.');
    }
    if (
      field.type === 'decimal' &&
      field.scale !== undefined &&
      !(Number.isInteger(field.scale) && field.scale >= 0 && field.scale <= 10)
    ) {
      error(path, 'As casas decimais têm de ser um inteiro entre 0 e 10.');
    }
    if (field.type === 'formula') checkFormula(field);
    if (field.type === 'lookup') checkLookup(field);
    if (field.type === 'auto-number') {
      for (const message of validateAutoNumber(field.autoNumber)) error(path, message);
      if (field.required) error(path, 'Uma numeração automática não pode ser obrigatória.');
      if (field.defaultValue !== undefined)
        error(path, 'Uma numeração automática não tem valor por omissão.');
    }
    if (field.type === 'file' || field.type === 'image') {
      if (field.accept?.some((a) => !isMimePattern(a)))
        error(path, 'Tipo MIME inválido em "accept" (ex.: image/*, application/pdf).');
      if (
        field.maxSizeBytes !== undefined &&
        (field.maxSizeBytes < 1 || field.maxSizeBytes > MAX_FILE_BYTES)
      )
        error(path, `O tamanho máximo tem de estar entre 1 byte e ${MAX_FILE_BYTES / 1048576} MB.`);
    }

    checkCondition(`${path}.visibleWhen`, field.visibleWhen);
    checkCondition(`${path}.editableWhen`, field.editableWhen);
    checkCondition(`${path}.requiredWhen`, field.requiredWhen);
    field.validations.forEach((rule, i) => checkRule(`${path}.validations[${i}]`, rule, field));
  }

  entity.rules.forEach((rule, i) => {
    const path = `rules[${i}]`;
    const target = fieldByKey.get(rule.field);
    if (!target) error(path, `A regra refere o campo desconhecido "${rule.field}".`);
    else checkRule(path, rule, target);
  });

  // --- formulários
  for (const form of entity.forms) {
    const used = new Set<string>();
    const visit = (items: readonly FormItem[], path: string) =>
      items.forEach((item, i) => {
        if (item.kind === 'group') return visit(item.items, `${path}[${i}]`);
        if (!fieldKeys.has(item.field))
          error(`${path}[${i}]`, `O formulário refere o campo desconhecido "${item.field}".`);
        if (used.has(item.field))
          error(`${path}[${i}]`, `O campo "${item.field}" aparece mais de uma vez.`);
        used.add(item.field);
      });
    form.sections.forEach((s, i) => visit(s.items, `forms.${form.key}.sections[${i}]`));
    if (form.modes.length === 0)
      error(`forms.${form.key}`, 'O formulário não é usado em nenhum modo.');
  }

  // --- listagem
  const listable = (key: string) =>
    fieldKeys.has(key) || (SYSTEM_COLUMNS as readonly string[]).includes(key);
  entity.list.columns.forEach((c, i) => {
    if (!listable(c.field)) error(`list.columns[${i}]`, `Coluna desconhecida "${c.field}".`);
  });
  entity.list.searchFields.forEach((k) => {
    const f = fieldByKey.get(k);
    if (!f) error('list.searchFields', `Campo de pesquisa desconhecido "${k}".`);
    else if (!fieldCapabilities(f.type).searchable)
      error('list.searchFields', `O campo "${k}" (${f.type}) não suporta pesquisa.`);
  });
  entity.list.filters.forEach((k) => {
    const field = fieldByKey.get(k);
    if (k === STATUS_KEY) {
      if (statusCodes.size === 0) error('list.filters', 'Filtro por estado sem estados definidos.');
    } else if (!field) error('list.filters', `Filtro desconhecido "${k}".`);
    else if (!hasOptions(field) && field.type !== 'boolean' && field.type !== 'checkbox')
      error('list.filters', `O campo "${k}" não suporta filtro (use lista, opções ou sim/não).`);
  });
  const sort = entity.list.defaultSort;
  if (sort && !listable(sort.field))
    error('list.defaultSort', `Ordenação por campo desconhecido "${sort.field}".`);
  if (entity.list.pageSize < 1 || entity.list.pageSize > 100)
    error('list.pageSize', 'A página tem de ter entre 1 e 100 registos.');

  // --- estados e workflow
  const codes = new Set<string>();
  for (const status of entity.statuses) {
    if (!CODE.test(status.code))
      error(`statuses.${status.code}`, `Código de estado inválido "${status.code}".`);
    if (codes.has(status.code)) error(`statuses.${status.code}`, 'Código de estado duplicado.');
    codes.add(status.code);
  }
  if (entity.statuses.filter((s) => s.initial).length > 1)
    error('statuses', 'Só pode haver um estado inicial.');

  const workflow = entity.workflow;
  if (workflow) {
    if (workflow.entityKey !== entity.key)
      error('workflow', 'O workflow pertence a outra entidade.');
    if (!statusCodes.has(workflow.initialStatus))
      error('workflow.initialStatus', `Estado inicial desconhecido "${workflow.initialStatus}".`);

    const keys = new Set<string>();
    workflow.transitions.forEach((t, i) => {
      const path = `workflow.transitions[${i}]`;
      if (keys.has(t.key)) error(path, `Chave de transição duplicada "${t.key}".`);
      keys.add(t.key);
      if (t.from.length === 0) error(path, 'A transição não tem estados de origem.');
      for (const from of t.from)
        if (!statusCodes.has(from)) error(path, `Estado de origem desconhecido "${from}".`);
      if (!statusCodes.has(t.to)) error(path, `Estado de destino desconhecido "${t.to}".`);
      checkCondition(`${path}.condition`, t.condition);
      for (const action of t.actions ?? []) {
        if (!fieldKeys.has(action.field))
          error(path, `A acção altera o campo desconhecido "${action.field}".`);
      }
    });

    const reachable = new Set([workflow.initialStatus]);
    for (let changed = true; changed;) {
      changed = false;
      for (const t of workflow.transitions) {
        if (t.from.some((f) => reachable.has(f)) && !reachable.has(t.to)) {
          reachable.add(t.to);
          changed = true;
        }
      }
    }
    for (const code of statusCodes) {
      if (!reachable.has(code))
        warn('workflow', `O estado "${code}" não é alcançável a partir do estado inicial.`);
    }
  } else if (entity.statuses.length > 0 && !entity.statuses.some((s) => s.initial)) {
    warn('statuses', 'Sem workflow nem estado inicial marcado, usa-se o primeiro estado.');
  }

  // --- permissões, políticas e auditoria
  for (const op of ENTITY_OPERATIONS) {
    if (!entity.permissions.operations[op])
      error(`permissions.operations.${op}`, 'Falta a permissão desta operação.');
  }
  entity.permissions.policies.forEach((p, i) =>
    checkCondition(`permissions.policies[${i}].when`, p.when),
  );
  if (entity.audit.trackedFields !== 'all') {
    for (const k of entity.audit.trackedFields)
      if (!fieldKeys.has(k)) error('audit.trackedFields', `Campo auditado desconhecido "${k}".`);
  }

  return issues;

  function checkCondition(path: string, condition: Condition | undefined): void {
    if (!condition) return;
    if (conditionDepth(condition) > MAX_CONDITION_DEPTH)
      error(path, `Condição demasiado profunda (máximo ${MAX_CONDITION_DEPTH}).`);
    for (const key of conditionFields(condition)) {
      if (key !== STATUS_KEY && !fieldKeys.has(key))
        error(path, `A condição refere o campo desconhecido "${key}".`);
    }
  }

  function checkRule(path: string, rule: ValidationRule, field: FieldDefinition): void {
    checkCondition(`${path}.when`, rule.when);
    switch (rule.type) {
      case 'pattern':
        if (!safeRegExp(rule.pattern, rule.ignoreCase))
          error(path, 'Padrão inválido, demasiado longo ou potencialmente perigoso.');
        break;
      case 'compare':
        if (!fieldKeys.has(rule.otherField))
          error(path, `Comparação com o campo desconhecido "${rule.otherField}".`);
        else if (rule.otherField === field.key)
          error(path, 'Um campo não pode ser comparado consigo próprio.');
        break;
      case 'minLength':
      case 'maxLength':
        if (!Number.isInteger(rule.value) || rule.value < 0)
          error(path, 'O limite tem de ser um inteiro ≥ 0.');
        break;
      case 'min':
      case 'max':
        if (!['number', 'decimal', 'currency'].includes(field.type))
          error(path, `${rule.type} só se aplica a campos numéricos.`);
        break;
      case 'unique':
        if (!fieldCapabilities(field.type).unique)
          error(path, `unique não se aplica ao tipo "${field.type}".`);
        break;
      default:
        break;
    }
  }
}

export const hasErrors = (issues: readonly DefinitionIssue[]): boolean =>
  issues.some((i) => i.severity === 'error');
