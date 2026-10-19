/** Campos personalizados de demonstração: cada tenant acrescenta os seus à entidade nativa Cliente. */
import { defineField, type FieldInput } from '../dynamic/engine/define-entity';
import type { CustomFieldDefinition } from '../dynamic/models/custom-definition.model';

const AT = '2026-03-01T09:00:00Z';

function custom(
  tenantId: string,
  displayOrder: number,
  input: FieldInput,
  options: { state?: CustomFieldDefinition['state']; showInList?: boolean } = {},
): CustomFieldDefinition {
  return {
    id: `cf-${tenantId}-${input.key}`,
    tenantId,
    entity: { kind: 'core', key: 'customer' },
    field: defineField({ ...input, origin: 'custom' } as FieldInput, displayOrder),
    displayOrder,
    showInList: options.showInList ?? false,
    state: options.state ?? 'active',
    version: 1,
    audit: { createdAt: AT, createdBy: 'u-admin', updatedAt: AT, updatedBy: 'u-admin' },
  };
}

export const MOCK_CUSTOM_FIELDS: readonly CustomFieldDefinition[] = [
  // Tenant A — Escola Horizonte
  custom(
    't-escola',
    1,
    {
      type: 'select',
      key: 'sectorActividade',
      label: 'Sector de actividade',
      filterable: true,
      options: [
        { value: 'educacao', label: 'Educação' },
        { value: 'saude', label: 'Saúde' },
        { value: 'comercio', label: 'Comércio' },
      ],
    },
    { showInList: true },
  ),
  custom('t-escola', 2, {
    type: 'text',
    key: 'nifSecundario',
    label: 'NIF secundário',
    sensitivity: 'sensitive',
    permissions: {
      read: 'entities.customer.sensitive.read',
      write: 'entities.customer.sensitive.write',
    },
    validations: [{ type: 'unique', message: 'Este NIF já está registado.' }],
  }),
  custom('t-escola', 3, {
    type: 'radio',
    key: 'categoriaCliente',
    label: 'Categoria',
    filterable: true,
    options: [
      { value: 'A', label: 'A' },
      { value: 'B', label: 'B' },
      { value: 'C', label: 'C' },
    ],
  }),
  custom('t-escola', 4, { type: 'date', key: 'dataRenovacao', label: 'Data de renovação' }),
  custom(
    't-escola',
    5,
    { type: 'text', key: 'faxAntigo', label: 'Fax (antigo)' },
    { state: 'archived' },
  ),

  // Tenant B — Transportes Atlas
  custom(
    't-atlas',
    1,
    {
      type: 'select',
      key: 'regiaoComercial',
      label: 'Região comercial',
      filterable: true,
      options: [
        { value: 'norte', label: 'Norte' },
        { value: 'centro', label: 'Centro' },
        { value: 'sul', label: 'Sul' },
      ],
    },
    { showInList: true },
  ),
  custom('t-atlas', 2, {
    type: 'text',
    key: 'codigoInterno',
    label: 'Código interno',
    validations: [{ type: 'unique', message: 'Este código interno já existe.' }],
  }),
];
