import type { EntityDefinition } from '../models/entity-definition.model';
import type { AuditAction, AuditChange } from '../models/entity-record.model';
import type { FieldValue } from '../models/field-definition.model';
import { formatFieldValue } from './format-value';
import { statusOf } from './workflow';

export const AUDIT_ACTION_LABELS: Record<AuditAction, string> = {
  create: 'Criado',
  update: 'Actualizado',
  transition: 'Mudança de estado',
  delete: 'Eliminado',
};

export interface ChangeSummary {
  readonly label: string;
  readonly from: string;
  readonly to: string;
}

/** Descreve uma alteração com os rótulos da definição (campo, opção ou estado), não os códigos. */
export function describeChange(entity: EntityDefinition, change: AuditChange): ChangeSummary {
  if (change.field === 'status') {
    const name = (code: FieldValue | undefined) =>
      typeof code === 'string' ? (statusOf(entity, code)?.name ?? code) : '—';
    return { label: 'Estado', from: name(change.from), to: name(change.to) };
  }
  const field = entity.fields.find((f) => f.key === change.field);
  if (!field)
    return { label: change.field, from: String(change.from ?? '—'), to: String(change.to ?? '—') };
  return {
    label: field.label,
    from: formatFieldValue(field, change.from),
    to: formatFieldValue(field, change.to),
  };
}
