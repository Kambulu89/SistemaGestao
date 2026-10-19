import { hasOptions, type FieldDefinition } from '../models/field-definition.model';
import type { EntityDefinition } from '../models/entity-definition.model';
import {
  type DefinitionIssue,
  hasErrors,
  validateEntityDefinition,
  type IntegrityOptions,
} from './definition-integrity';

export type ChangeSeverity = 'safe' | 'warning' | 'breaking';

export interface DefinitionChange {
  readonly severity: ChangeSeverity;
  readonly path: string;
  readonly message: string;
}

const optionValues = (f: FieldDefinition): ReadonlySet<string> =>
  new Set(hasOptions(f) ? f.options.map((o) => o.value) : []);

/**
 * Compara duas versões da mesma entidade e classifica cada diferença.
 * "Destrutivo" = pode deixar registos existentes sem significado (campo removido ou renomeado,
 * tipo alterado, opção ou estado retirados). Para retirar um campo marque-o `archived`.
 */
/**
 * Diferenças de um campo entre duas versões. Partilhado pelas entidades (`diffDefinitions`) e
 * pelos campos personalizados (`checkCustomFieldChange`).
 */
export function diffField(
  before: FieldDefinition,
  after: FieldDefinition,
  path = `fields.${before.key}`,
): DefinitionChange[] {
  const changes: DefinitionChange[] = [];
  const add = (severity: ChangeSeverity, message: string) =>
    changes.push({ severity, path, message });

  if (after.type !== before.type)
    add('breaking', `O tipo mudou de ${before.type} para ${after.type}.`);
  if (after.archived && !before.archived)
    add('safe', 'Campo arquivado (os dados são preservados).');
  if (!before.required && after.required)
    add(
      'warning',
      'Passou a obrigatório: os registos existentes sem valor ficam inválidos até serem corrigidos.',
    );

  const removed = [...optionValues(before)].filter((v) => !optionValues(after).has(v));
  if (removed.length > 0)
    add('breaking', `Opções retiradas: ${removed.join(', ')}. Desactive-as em vez de as remover.`);
  if (hasOptions(after) && [...optionValues(after)].some((v) => !optionValues(before).has(v)))
    add('safe', 'Opções acrescentadas.');
  if (hasOptions(before) && hasOptions(after)) {
    const wasActive = new Set(before.options.filter((o) => o.active !== false).map((o) => o.value));
    const nowInactive = after.options
      .filter((o) => o.active === false && wasActive.has(o.value))
      .map((o) => o.value);
    if (nowInactive.length > 0)
      add(
        'safe',
        `Opções desactivadas: ${nowInactive.join(', ')} (os dados existentes mantêm-se).`,
      );
  }

  if (
    before.type === 'currency' &&
    after.type === 'currency' &&
    (after.scale ?? 2) < (before.scale ?? 2)
  ) {
    add('breaking', 'A precisão da moeda diminuiu: valores existentes perderiam casas decimais.');
  }
  if (
    before.type === 'currency' &&
    after.type === 'currency' &&
    after.currency !== before.currency
  ) {
    add('breaking', 'A moeda mudou: os valores existentes ficariam com outro significado.');
  }
  if (
    before.type === 'formula' &&
    after.type === 'formula' &&
    (after.formula.source !== before.formula.source || after.scale !== before.scale)
  )
    add('warning', 'A fórmula mudou: os valores calculados são recalculados em todos os registos.');
  if (
    before.type === 'auto-number' &&
    after.type === 'auto-number' &&
    JSON.stringify(after.autoNumber) !== JSON.stringify(before.autoNumber)
  )
    add(
      'warning',
      'A numeração mudou: só afecta os registos novos; os números atribuídos mantêm-se.',
    );
  if (
    before.type === 'entity-reference' &&
    after.type === 'entity-reference' &&
    after.entityKey !== before.entityKey
  )
    add('breaking', 'A entidade referenciada mudou: as referências existentes ficariam inválidas.');
  if (
    before.type === 'lookup' &&
    after.type === 'lookup' &&
    JSON.stringify(after.lookup) !== JSON.stringify(before.lookup)
  )
    add(
      'warning',
      'O valor relacionado mudou: passa a mostrar outro campo do registo referenciado.',
    );
  if (before.sensitivity !== 'sensitive' && after.sensitivity === 'sensitive')
    add('warning', 'Passou a dados sensíveis: reveja quem tem acesso.');
  const unique = (f: FieldDefinition) => f.validations.some((v) => v.type === 'unique');
  if (!unique(before) && unique(after))
    add('warning', 'Passou a único: valores duplicados existentes ficam inválidos.');
  if (after.label !== before.label) add('safe', 'Rótulo alterado.');
  return changes;
}

/**
 * Compara duas versões da mesma entidade e classifica cada diferença.
 * "Destrutivo" = pode deixar registos existentes sem significado (campo removido ou renomeado,
 * tipo alterado, opção ou estado retirados). Para retirar um campo marque-o `archived`.
 */
export function diffDefinitions(
  previous: EntityDefinition,
  next: EntityDefinition,
): DefinitionChange[] {
  const changes: DefinitionChange[] = [];
  const add = (severity: ChangeSeverity, path: string, message: string) =>
    changes.push({ severity, path, message });

  if (next.key !== previous.key) add('breaking', 'key', 'A chave da entidade não pode mudar.');
  if (next.version !== previous.version + 1)
    add('breaking', 'version', `A nova versão tem de ser ${previous.version + 1}.`);

  const nextFields = new Map(next.fields.map((f) => [f.key, f]));
  for (const before of previous.fields) {
    const after = nextFields.get(before.key);
    if (!after) {
      add(
        'breaking',
        `fields.${before.key}`,
        `O campo "${before.key}" foi removido ou renomeado. Marque-o como arquivado para preservar os dados.`,
      );
      continue;
    }
    changes.push(...diffField(before, after));
  }

  const previousKeys = new Set(previous.fields.map((f) => f.key));
  for (const field of next.fields) {
    if (previousKeys.has(field.key)) continue;
    const mandatory = field.required && field.defaultValue === undefined;
    add(
      mandatory ? 'warning' : 'safe',
      `fields.${field.key}`,
      mandatory ? 'Campo novo obrigatório sem valor por omissão.' : 'Campo acrescentado.',
    );
  }

  const nextStatuses = new Set(next.statuses.map((s) => s.code));
  for (const status of previous.statuses) {
    if (!nextStatuses.has(status.code))
      add('breaking', `statuses.${status.code}`, `O estado "${status.code}" foi retirado.`);
  }
  if (
    previous.workflow &&
    next.workflow &&
    previous.workflow.initialStatus !== next.workflow.initialStatus
  ) {
    add('warning', 'workflow.initialStatus', 'O estado inicial mudou (só afecta registos novos).');
  }
  return changes;
}

export interface PublishCheck {
  readonly ok: boolean;
  readonly issues: readonly DefinitionIssue[];
  readonly changes: readonly DefinitionChange[];
  readonly breaking: readonly DefinitionChange[];
}

/**
 * Verifica se um rascunho pode ser publicado: integridade sem erros e nenhuma alteração destrutiva
 * face à versão publicada. Não migra dados: alterações destrutivas exigem uma migração planeada.
 */
export function checkPublishable(
  published: EntityDefinition | null,
  draft: EntityDefinition,
  options?: IntegrityOptions,
): PublishCheck {
  const issues = validateEntityDefinition(draft, options);
  const changes = published ? diffDefinitions(published, draft) : [];
  const breaking = changes.filter((c) => c.severity === 'breaking');
  return {
    ok: !hasErrors(issues) && breaking.length === 0 && draft.state === 'draft',
    issues,
    changes,
    breaking,
  };
}
