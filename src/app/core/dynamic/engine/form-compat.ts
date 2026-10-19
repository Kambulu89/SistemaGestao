import type { EntityDefinition } from '../models/entity-definition.model';
import type { FormDefinition } from '../models/form-definition.model';
import type { DefinitionChange } from './definition-compat';
import { indexFormFields } from './form-config';
import {
  type FormIntegrityOptions,
  type FormIssue,
  hasFormErrors,
  validateFormDefinition,
} from './form-integrity';

/**
 * Compara duas versões do mesmo formulário. Um formulário não guarda dados: tirar um campo só
 * deixa de o mostrar, por isso quase nada é destrutivo; o que muda para os utilizadores é «aviso».
 */
export function diffForms(previous: FormDefinition, next: FormDefinition): DefinitionChange[] {
  const changes: DefinitionChange[] = [];
  const add = (severity: DefinitionChange['severity'], path: string, message: string) =>
    changes.push({ severity, path, message });
  const base = `forms.${previous.key}`;

  if (previous.entityKey !== undefined && previous.entityKey !== next.entityKey)
    add('breaking', base, 'O formulário não pode mudar de entidade.');
  if (previous.key !== next.key) add('breaking', base, 'O código de um formulário não muda.');

  const before = indexFormFields(previous);
  const after = indexFormFields(next);
  for (const key of before.keys())
    if (!after.has(key))
      add('warning', `${base}.${key}`, `O campo "${key}" deixa de aparecer no formulário.`);
  for (const key of after.keys())
    if (!before.has(key)) add('safe', `${base}.${key}`, `O campo "${key}" passa a aparecer.`);
  for (const [key, entry] of after) {
    const old = before.get(key);
    if (!old) continue;
    if (!old.item.required && entry.item.required)
      add('warning', `${base}.${key}`, `"${key}" passa a obrigatório neste formulário.`);
    if (old.item.visible !== false && entry.item.visible === false)
      add('warning', `${base}.${key}`, `"${key}" passa a escondido neste formulário.`);
    if (old.item.editable !== false && entry.item.editable === false)
      add('warning', `${base}.${key}`, `"${key}" passa a só de leitura neste formulário.`);
    if (old.item.label !== entry.item.label) add('safe', `${base}.${key}`, 'Rótulo alterado.');
  }

  for (const mode of previous.modes.filter((m) => !next.modes.includes(m)))
    add('warning', base, `O formulário deixa de ser usado em: ${mode}.`);
  for (const mode of next.modes.filter((m) => !previous.modes.includes(m)))
    add('safe', base, `O formulário passa a ser usado em: ${mode}.`);
  if (Boolean(previous.isDefault) !== Boolean(next.isDefault))
    add(
      'warning',
      base,
      next.isDefault
        ? 'Passa a ser o formulário por omissão.'
        : 'Deixa de ser o formulário por omissão.',
    );
  return changes;
}

export interface FormPublishCheck {
  readonly ok: boolean;
  readonly issues: readonly FormIssue[];
  readonly changes: readonly DefinitionChange[];
  readonly breaking: readonly DefinitionChange[];
}

/**
 * Verifica se um rascunho de formulário pode ser publicado: integridade estrita sem erros, nenhuma
 * alteração destrutiva face à versão publicada e estado `draft`. O backend repete esta verificação.
 */
export function checkFormPublishable(
  published: FormDefinition | null,
  draft: FormDefinition,
  entity: EntityDefinition,
  options: FormIntegrityOptions = {},
): FormPublishCheck {
  const issues = validateFormDefinition(draft, entity, { strict: true, ...options });
  const changes = published ? diffForms(published, draft) : [];
  const breaking = changes.filter((c) => c.severity === 'breaking');
  return {
    ok: !hasFormErrors(issues) && breaking.length === 0 && draft.state === 'draft',
    issues,
    changes,
    breaking,
  };
}
