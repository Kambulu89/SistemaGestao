import type { EntityDefinition } from '../models/entity-definition.model';
import {
  entityRefOf,
  type CustomFieldDefinition,
  entityRefId,
} from '../models/custom-definition.model';
import type { FieldDefinition } from '../models/field-definition.model';
import type { FormDefinition, FormItem } from '../models/form-definition.model';
import { type DefinitionChange, diffField } from './definition-compat';
import {
  type DefinitionIssue,
  RESERVED_FIELD_KEYS,
  validateEntityDefinition,
} from './definition-integrity';
import { fieldCapabilities } from './field-types';

export interface SkippedCustomField {
  readonly code: string;
  readonly reason: string;
}

export interface MergeResult {
  readonly entity: EntityDefinition;
  /** Campos que não puderam ser fundidos (ex.: o código colide com um campo nativo). */
  readonly skipped: readonly SkippedCustomField[];
}

export interface MergeOptions {
  /** Inclui também os campos em rascunho (pré-visualização no designer). */
  readonly includeDrafts?: boolean;
}

export const CUSTOM_SECTION_TITLE = 'Campos personalizados';

const fieldKeysIn = (items: readonly FormItem[]): string[] =>
  items.flatMap((i) => (i.kind === 'field' ? [i.field] : fieldKeysIn(i.items)));

function appendCustomSection(form: FormDefinition, customKeys: readonly string[]): FormDefinition {
  const used = new Set(form.sections.flatMap((s) => fieldKeysIn(s.items)));
  const missing = customKeys.filter((k) => !used.has(k));
  if (missing.length === 0) return form;
  const key = form.sections.some((s) => s.key === 'custom') ? 'custom-fields' : 'custom';
  return {
    ...form,
    sections: [
      ...form.sections,
      {
        key,
        title: CUSTOM_SECTION_TITLE,
        columns: 2,
        items: missing.map((field) => ({ kind: 'field', field })),
      },
    ],
  };
}

/**
 * Funde os campos personalizados de um tenant numa entidade nativa extensível. O resultado é uma
 * `EntityDefinition` normal: os renderers e os motores não sabem que há campos personalizados.
 * Só se fundem os campos do tenant indicado, da entidade certa e activos (ou rascunhos, a pedido).
 * A definição nativa nunca é alterada.
 */
export function mergeCustomFieldsDetailed(
  entity: EntityDefinition,
  customFields: readonly CustomFieldDefinition[],
  tenantId: string,
  options: MergeOptions = {},
): MergeResult {
  if (!entity.extensible) return { entity, skipped: [] };

  const ref = entityRefId(entityRefOf(entity));
  const wanted = customFields
    .filter(
      (c) =>
        c.tenantId === tenantId &&
        entityRefId(c.entity) === ref &&
        (c.state === 'active' || (options.includeDrafts === true && c.state === 'draft')),
    )
    .sort((a, b) => a.displayOrder - b.displayOrder || a.id.localeCompare(b.id));

  const taken = new Set([...entity.fields.map((f) => f.key), ...RESERVED_FIELD_KEYS]);
  const skipped: SkippedCustomField[] = [];
  const merged: { def: CustomFieldDefinition; field: FieldDefinition }[] = [];
  const baseOrder = Math.max(0, ...entity.fields.map((f) => f.order));

  for (const def of wanted) {
    const code = def.field.key;
    if (taken.has(code)) {
      skipped.push({ code, reason: 'O código colide com um campo existente.' });
      continue;
    }
    taken.add(code);
    merged.push({
      def,
      field: { ...def.field, origin: 'custom', order: baseOrder + (merged.length + 1) * 10 },
    });
  }
  if (merged.length === 0) return { entity, skipped };

  const keys = merged.map((m) => m.field.key);
  const caps = (m: (typeof merged)[number]) => fieldCapabilities(m.field.type);

  const listColumns = merged
    .filter((m) => m.def.showInList && caps(m).listable)
    .map((m) => ({ field: m.field.key }));
  const statusAt = entity.list.columns.findIndex((c) => c.field === 'status');
  const columns =
    statusAt >= 0
      ? [
          ...entity.list.columns.slice(0, statusAt),
          ...listColumns,
          ...entity.list.columns.slice(statusAt),
        ]
      : [...entity.list.columns, ...listColumns];

  return {
    skipped,
    entity: {
      ...entity,
      fields: [...entity.fields, ...merged.map((m) => m.field)],
      forms: entity.forms.map((f) => appendCustomSection(f, keys)),
      list: {
        ...entity.list,
        columns,
        searchFields: [
          ...entity.list.searchFields,
          ...merged.filter((m) => m.field.searchable && caps(m).searchable).map((m) => m.field.key),
        ],
        filters: [
          ...entity.list.filters,
          ...merged.filter((m) => m.field.filterable && caps(m).filterable).map((m) => m.field.key),
        ],
      },
      audit:
        entity.audit.trackedFields === 'all'
          ? entity.audit
          : { ...entity.audit, trackedFields: [...entity.audit.trackedFields, ...keys] },
    },
  };
}

export function mergeCustomFields(
  entity: EntityDefinition,
  customFields: readonly CustomFieldDefinition[],
  tenantId: string,
  options?: MergeOptions,
): EntityDefinition {
  return mergeCustomFieldsDetailed(entity, customFields, tenantId, options).entity;
}

/**
 * Valida a definição de um campo personalizado no contexto da entidade a que pertence:
 * entidade extensível, código sem colisões (nem com campos arquivados) e as regras de integridade
 * de qualquer campo (tipo, opções, capacidades…), avaliadas sobre a entidade já fundida.
 */
export function validateCustomFieldDefinition(
  entity: EntityDefinition | undefined,
  candidate: CustomFieldDefinition,
  siblings: readonly CustomFieldDefinition[],
  options: { readonly knownEntityKeys?: ReadonlySet<string> } = {},
): DefinitionIssue[] {
  const issues: DefinitionIssue[] = [];
  const error = (path: string, message: string) =>
    issues.push({ severity: 'error', path, message });
  const code = candidate.field.key;
  const path = `customFields.${code}`;

  if (!entity) {
    error(path, `A entidade "${candidate.entity.key}" não existe.`);
    return issues;
  }
  if (!entity.extensible)
    error(path, `A entidade "${entity.key}" não aceita campos personalizados.`);
  if (entityRefId(candidate.entity) !== entityRefId(entityRefOf(entity)))
    error(path, 'O campo não pertence a esta entidade.');
  if (!candidate.tenantId) error(path, 'O campo tem de indicar o tenant proprietário.');
  if (candidate.field.origin !== 'custom')
    error(path, 'Um campo personalizado tem de ter origin "custom".');
  if (!Number.isInteger(candidate.displayOrder) || candidate.displayOrder < 0)
    error(path, 'A ordem tem de ser um inteiro ≥ 0.');
  if (entity.fields.some((f) => f.key === code))
    error(path, `O código "${code}" colide com um campo nativo.`);

  const others = siblings.filter(
    (s) =>
      s.id !== candidate.id &&
      s.tenantId === candidate.tenantId &&
      entityRefId(s.entity) === entityRefId(candidate.entity),
  );
  if (others.some((s) => s.field.key === code))
    error(
      path,
      `O código "${code}" já existe (mesmo que o campo esteja arquivado, não se reutiliza).`,
    );

  // Regras gerais de campo, avaliadas sobre a entidade com este campo incluído.
  const trial: CustomFieldDefinition = { ...candidate, state: 'active' };
  const merged = mergeCustomFields(entity, [...others, trial], candidate.tenantId, {
    includeDrafts: true,
  });
  for (const issue of validateEntityDefinition(merged, options)) {
    if (
      issue.severity === 'error' &&
      (issue.path.includes(`.${code}`) ||
        issue.path.startsWith('list.') ||
        issue.path.startsWith('forms.'))
    ) {
      if (!issues.some((i) => i.message === issue.message)) issues.push(issue);
    }
  }
  return issues;
}

/**
 * Alterações a um campo personalizado já publicado. Enquanto é rascunho, tudo se pode mudar.
 * Depois de publicado, o código e o tipo ficam fixos e não se retiram opções (desactivam-se).
 */
export function checkCustomFieldChange(
  previous: CustomFieldDefinition,
  next: CustomFieldDefinition,
): DefinitionChange[] {
  if (previous.state === 'draft') return [];
  const path = `customFields.${previous.field.key}`;
  const changes: DefinitionChange[] = [];

  if (next.field.key !== previous.field.key) {
    changes.push({
      severity: 'breaking',
      path,
      message: 'O código de um campo publicado não pode mudar.',
    });
  }
  if (
    entityRefId(next.entity) !== entityRefId(previous.entity) ||
    next.tenantId !== previous.tenantId
  ) {
    changes.push({
      severity: 'breaking',
      path,
      message: 'Um campo não muda de entidade nem de tenant.',
    });
  }
  if (next.state === 'draft') {
    changes.push({
      severity: 'breaking',
      path,
      message: 'Um campo publicado não volta a rascunho.',
    });
  }
  if (next.state === 'archived' && previous.state === 'active') {
    changes.push({
      severity: 'safe',
      path,
      message: 'Campo arquivado (os dados são preservados).',
    });
  }
  return [...changes, ...diffField(previous.field, next.field, path)];
}
