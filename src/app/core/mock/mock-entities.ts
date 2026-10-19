/**
 * Definições de entidades de demonstração. São só dados: nenhum motor ou renderer conhece
 * "Viatura". Apagar este ficheiro (e o mock) é o que falta para ligar ao backend real.
 */
import { defineEntity, type FieldInput } from '../dynamic/engine/define-entity';
import type { FormDefinition } from '../dynamic/models/form-definition.model';
import { moduleId } from '../modules/define-module';

const DYNAMIC_MODULE = moduleId('configuration.forms');
export const ATLAS_TENANT_ID = 't-atlas';

// ------------------------------------------------------------ Cliente (nativa)

/**
 * Entidade nativa da plataforma (módulo CRM). É `extensible`: cada tenant pode acrescentar-lhe
 * campos personalizados sem alterar esta definição, que é a mesma para todos.
 */
export const CUSTOMER_V1 = defineEntity({
  key: 'customer',
  scope: 'global',
  tenantId: null,
  moduleId: moduleId('crm.customers'),
  version: 1,
  extensible: true,
  names: { singular: 'Cliente', plural: 'Clientes' },
  description: 'Clientes e contactos (entidade nativa do CRM).',
  icon: 'users',
  fields: [
    { type: 'text', key: 'nome', label: 'Nome', required: true, searchable: true },
    { type: 'email', key: 'email', label: 'Email', searchable: true },
    { type: 'phone', key: 'telefone', label: 'Telefone' },
  ],
  list: {
    columns: [{ field: 'nome' }, { field: 'email' }, { field: 'telefone' }],
    defaultSort: { field: 'nome', direction: 'asc' },
    pageSize: 8,
  },
});

// ------------------------------------------------------------------ Viatura

const VEHICLE_FIELDS_V1: readonly FieldInput[] = [
  {
    type: 'text',
    key: 'matricula',
    label: 'Matrícula',
    placeholder: 'AA-00-AA',
    required: true,
    searchable: true,
    validations: [
      { type: 'maxLength', value: 15 },
      { type: 'unique', message: 'Já existe uma viatura com esta matrícula.' },
    ],
  },
  { type: 'text', key: 'marca', label: 'Marca', required: true, searchable: true },
  { type: 'text', key: 'modelo', label: 'Modelo' },
  {
    type: 'select',
    key: 'combustivel',
    label: 'Combustível',
    filterable: true,
    options: [
      { value: 'gasolina', label: 'Gasolina' },
      { value: 'gasoleo', label: 'Gasóleo' },
      { value: 'eletrico', label: 'Eléctrico' },
      { value: 'hibrido', label: 'Híbrido' },
    ],
  },
  {
    type: 'number',
    key: 'quilometragem',
    label: 'Quilometragem',
    defaultValue: 0,
    validations: [{ type: 'min', value: 0, message: 'A quilometragem não pode ser negativa.' }],
  },
];

/** A v2 acrescenta o campo `numeroChassis`; os registos da v1 continuam válidos. */
const VEHICLE_FIELDS_V2: readonly FieldInput[] = [
  ...VEHICLE_FIELDS_V1,
  {
    type: 'text',
    key: 'numeroChassis',
    label: 'Nº de chassis',
    description: 'VIN com 17 caracteres.',
    validations: [{ type: 'maxLength', value: 17 }],
  },
];

const vehicleForm = (withChassis: boolean): FormDefinition => ({
  key: 'vehicle-default',
  name: 'Viatura',
  modes: ['create', 'edit', 'read'],
  sections: [
    {
      key: 'identification',
      title: 'Identificação',
      columns: 3,
      items: [
        { kind: 'field', field: 'matricula' },
        { kind: 'field', field: 'marca' },
        { kind: 'field', field: 'modelo' },
      ],
    },
    {
      key: 'characteristics',
      title: 'Características',
      columns: 3,
      items: [
        { kind: 'field', field: 'combustivel' },
        { kind: 'field', field: 'quilometragem' },
        ...(withChassis
          ? [{ kind: 'field' as const, field: 'numeroChassis', span: 3 as const }]
          : []),
      ],
    },
  ],
});

const VEHICLE_BASE = {
  key: 'vehicle',
  scope: 'tenant',
  tenantId: ATLAS_TENANT_ID,
  moduleId: DYNAMIC_MODULE,
  names: { singular: 'Viatura', plural: 'Viaturas' },
  description: 'Frota de viaturas da empresa.',
  icon: 'truck',
  statuses: [
    { code: 'available', name: 'Disponível', color: 'success', initial: true },
    { code: 'maintenance', name: 'Em manutenção', color: 'warning' },
    { code: 'inactive', name: 'Inactiva', color: 'neutral', description: 'Fora de serviço.' },
  ],
  workflow: {
    name: 'Ciclo de vida da viatura',
    initialStatus: 'available',
    transitions: [
      {
        key: 'send-to-maintenance',
        name: 'Enviar para manutenção',
        from: ['available'],
        to: 'maintenance',
      },
      {
        key: 'finish-maintenance',
        name: 'Concluir manutenção',
        from: ['maintenance'],
        to: 'available',
        events: ['vehicle.maintenance.finished'],
      },
      {
        key: 'deactivate',
        name: 'Desactivar',
        from: ['available'],
        to: 'inactive',
        approval: { permission: 'entities.vehicle.approve' },
      },
      {
        key: 'reactivate',
        name: 'Reactivar',
        from: ['inactive'],
        to: 'available',
        approval: { permission: 'entities.vehicle.approve' },
      },
    ],
  },
  policies: [
    {
      operation: 'delete',
      effect: 'deny',
      when: { op: 'neq', field: 'status', value: 'inactive' },
      message: 'Só é possível eliminar viaturas inactivas.',
    },
  ],
  list: {
    columns: [
      { field: 'matricula' },
      { field: 'marca' },
      { field: 'modelo' },
      { field: 'combustivel' },
      { field: 'quilometragem' },
      { field: 'status' },
    ],
    defaultSort: { field: 'matricula', direction: 'asc' },
    pageSize: 8,
  },
} as const;

export const VEHICLE_V1 = defineEntity({
  ...VEHICLE_BASE,
  version: 1,
  state: 'archived',
  fields: VEHICLE_FIELDS_V1,
  forms: [vehicleForm(false)],
  publishedAt: '2026-03-02T09:00:00Z',
});

export const VEHICLE_V2 = defineEntity({
  ...VEHICLE_BASE,
  version: 2,
  state: 'published',
  fields: VEHICLE_FIELDS_V2,
  forms: [vehicleForm(true)],
  publishedAt: '2026-06-18T14:30:00Z',
});

// ------------------------------------------------------------------ Condutor

export const DRIVER_V1 = defineEntity({
  key: 'driver',
  scope: 'tenant',
  tenantId: ATLAS_TENANT_ID,
  moduleId: DYNAMIC_MODULE,
  version: 1,
  names: { singular: 'Condutor', plural: 'Condutores' },
  description: 'Condutores e respectivas cartas de condução.',
  icon: 'users',
  fields: [
    { type: 'text', key: 'nome', label: 'Nome', required: true, searchable: true },
    {
      type: 'text',
      key: 'numeroCarta',
      label: 'Nº da carta',
      required: true,
      searchable: true,
      validations: [{ type: 'unique' }],
    },
    {
      type: 'select',
      key: 'categoria',
      label: 'Categoria',
      required: true,
      filterable: true,
      options: [
        { value: 'B', label: 'B (ligeiros)' },
        { value: 'C', label: 'C (pesados de mercadorias)' },
        { value: 'D', label: 'D (pesados de passageiros)' },
      ],
    },
    {
      type: 'text',
      key: 'numeroCap',
      label: 'Nº do CAP',
      description: 'Obrigatório para as categorias C e D.',
      visibleWhen: { op: 'in', field: 'categoria', values: ['C', 'D'] },
      requiredWhen: { op: 'in', field: 'categoria', values: ['C', 'D'] },
    },
    { type: 'date', key: 'validadeCarta', label: 'Validade da carta', required: true },
    { type: 'phone', key: 'telefone', label: 'Telefone' },
    { type: 'email', key: 'email', label: 'Email' },
    {
      type: 'entity-reference',
      key: 'viatura',
      label: 'Viatura atribuída',
      entityKey: 'vehicle',
      filterable: false,
    },
  ],
  list: {
    columns: [
      { field: 'nome' },
      { field: 'numeroCarta' },
      { field: 'categoria' },
      { field: 'validadeCarta' },
      { field: 'viatura' },
    ],
    defaultSort: { field: 'nome', direction: 'asc' },
    pageSize: 8,
  },
});

// -------------------------------------------------------------------- Nota (global)

export const NOTE_V1 = defineEntity({
  key: 'note',
  scope: 'global',
  tenantId: null,
  moduleId: DYNAMIC_MODULE,
  version: 1,
  names: { singular: 'Nota', plural: 'Notas' },
  description: 'Entidade global da plataforma, disponível a todos os tenants com o módulo.',
  icon: 'document',
  fields: [
    { type: 'text', key: 'titulo', label: 'Título', required: true, searchable: true },
    { type: 'textarea', key: 'conteudo', label: 'Conteúdo' },
    {
      type: 'select',
      key: 'prioridade',
      label: 'Prioridade',
      defaultValue: 'media',
      filterable: true,
      options: [
        { value: 'baixa', label: 'Baixa' },
        { value: 'media', label: 'Média' },
        { value: 'alta', label: 'Alta' },
      ],
    },
    { type: 'date', key: 'prazo', label: 'Prazo' },
    {
      type: 'boolean',
      key: 'concluida',
      label: 'Concluída',
      defaultValue: false,
      filterable: true,
    },
  ],
  list: {
    columns: [
      { field: 'titulo' },
      { field: 'prioridade' },
      { field: 'prazo' },
      { field: 'concluida' },
    ],
    defaultSort: { field: 'updatedAt', direction: 'desc' },
    pageSize: 8,
  },
});

/** Todas as definições do "servidor" mock. O gateway filtra por tenant, como faria o backend. */
export const MOCK_ENTITY_DEFINITIONS = [
  CUSTOMER_V1,
  NOTE_V1,
  VEHICLE_V1,
  VEHICLE_V2,
  DRIVER_V1,
] as const;
