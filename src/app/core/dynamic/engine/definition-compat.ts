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
    const path = `fields.${before.key}`;
    if (!after) {
      add(
        'breaking',
        path,
        `O campo "${before.key}" foi removido ou renomeado. Marque-o como arquivado para preservar os dados.`,
      );
      continue;
    }
    if (after.type !== before.type)
      add('breaking', path, `O tipo mudou de ${before.type} para ${after.type}.`);
    if (after.archived && !before.archived)
      add('safe', path, 'Campo arquivado (os dados são preservados).');
    if (!before.required && after.required)
      add(
        'warning',
        path,
        'Passou a obrigatório: os registos existentes sem valor ficam inválidos até serem corrigidos.',
      );

    const removed = [...optionValues(before)].filter((v) => !optionValues(after).has(v));
    if (removed.length > 0) add('breaking', path, `Opções retiradas: ${removed.join(', ')}.`);
    if (hasOptions(after) && [...optionValues(after)].some((v) => !optionValues(before).has(v)))
      add('safe', path, 'Opções acrescentadas.');
    if (after.label !== before.label) add('safe', path, 'Rótulo alterado.');
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
