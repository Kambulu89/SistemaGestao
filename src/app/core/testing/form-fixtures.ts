import { defineEntity } from '../dynamic/engine/define-entity';
import type { EntityDefinition } from '../dynamic/models/entity-definition.model';
import type { FormDefinition } from '../dynamic/models/form-definition.model';

/** Entidade de apoio aos testes do Form Builder (Cadastro de Cliente). */
export const CLIENTE: EntityDefinition = defineEntity({
  key: 'cliente',
  scope: 'tenant',
  tenantId: 't-a',
  names: { singular: 'Cliente', plural: 'Clientes' },
  icon: 'users',
  fields: [
    { type: 'text', key: 'nome', label: 'Nome', required: true },
    { type: 'text', key: 'nif', label: 'NIF' },
    { type: 'phone', key: 'telefone', label: 'Telefone' },
    {
      type: 'select',
      key: 'segmento',
      label: 'Segmento',
      options: [
        { value: 'particular', label: 'Particular' },
        { value: 'empresarial', label: 'Empresarial' },
        { value: 'antigo', label: 'Antigo', active: false },
      ],
    },
    { type: 'currency', key: 'limiteCredito', label: 'Limite de crédito', currency: 'EUR' },
    {
      type: 'auto-number',
      key: 'numero',
      label: 'Número',
      autoNumber: { prefix: 'C-', padding: 4, start: 1, reset: 'never' },
    },
  ],
});

/** O formulário «Cadastro de Cliente» do caso de uso: duas secções, só metadados. */
export const CADASTRO_CLIENTE: FormDefinition = {
  key: 'cadastro-cliente',
  name: 'Cadastro de Cliente',
  modes: ['create'],
  sections: [
    {
      key: 'pessoais',
      title: 'Dados pessoais',
      columns: 1,
      items: [
        { kind: 'field', field: 'nome' },
        { kind: 'field', field: 'nif' },
        { kind: 'field', field: 'telefone' },
      ],
    },
    {
      key: 'comerciais',
      title: 'Dados comerciais',
      columns: 1,
      items: [
        { kind: 'field', field: 'segmento', placeholder: 'Seleccionar segmento' },
        {
          kind: 'field',
          field: 'limiteCredito',
          visibleWhen: { op: 'eq', field: 'segmento', value: 'empresarial' },
        },
      ],
    },
  ],
};
