import type { FieldType } from '../models/field-definition.model';

/** O que um tipo de campo pode fazer. O motor valida a configuração contra estas capacidades. */
export interface FieldCapabilities {
  /** O utilizador pode escrever o valor. `false` = calculado ou atribuído pelo servidor. */
  readonly writable: boolean;
  readonly defaultValue: boolean;
  readonly required: boolean;
  readonly unique: boolean;
  readonly searchable: boolean;
  readonly filterable: boolean;
  readonly sortable: boolean;
  readonly listable: boolean;
  readonly exportable: boolean;
  /** Tem uma lista de opções. */
  readonly options: boolean;
}

/**
 * `ready`: disponível no designer e nos renderers. `preview`: o contrato existe mas a
 * funcionalidade ainda não está implementada de ponta a ponta.
 */
export type FieldTypeStatus = 'ready' | 'preview';

export interface FieldTypeDefinition {
  readonly type: FieldType;
  readonly label: string;
  readonly description: string;
  readonly status: FieldTypeStatus;
  readonly capabilities: FieldCapabilities;
}

const none: FieldCapabilities = {
  writable: true,
  defaultValue: false,
  required: true,
  unique: false,
  searchable: false,
  filterable: false,
  sortable: false,
  listable: true,
  exportable: true,
  options: false,
};

const def = (
  type: FieldType,
  label: string,
  description: string,
  status: FieldTypeStatus,
  caps: Partial<FieldCapabilities>,
): FieldTypeDefinition => ({
  type,
  label,
  description,
  status,
  capabilities: { ...none, ...caps },
});

/**
 * Catálogo de tipos de campo. Nem todo o campo se pesquisa ou ordena de forma eficiente:
 * `searchable`, `filterable` e `sortable` só ficam `true` onde o backend consegue indexar.
 */
export const FIELD_TYPE_CATALOG: readonly FieldTypeDefinition[] = [
  def('text', 'Texto', 'Texto curto.', 'ready', {
    defaultValue: true,
    unique: true,
    searchable: true,
    sortable: true,
  }),
  def('textarea', 'Texto longo', 'Várias linhas de texto.', 'ready', {
    defaultValue: true,
    searchable: true,
  }),
  def('number', 'Número inteiro', 'Número sem casas decimais.', 'ready', {
    defaultValue: true,
    unique: true,
    filterable: true,
    sortable: true,
  }),
  def('decimal', 'Decimal', 'Número com casas decimais.', 'ready', {
    defaultValue: true,
    sortable: true,
  }),
  def('currency', 'Moeda', 'Valor monetário com moeda e precisão.', 'ready', {
    defaultValue: true,
    sortable: true,
  }),
  def('boolean', 'Sim/Não', 'Valor verdadeiro ou falso.', 'ready', {
    defaultValue: true,
    filterable: true,
  }),
  def(
    'checkbox',
    'Caixa de marcação',
    'Uma caixa; se obrigatória, tem de estar marcada.',
    'ready',
    { defaultValue: true, filterable: true },
  ),
  def('date', 'Data', 'Dia, mês e ano.', 'ready', { defaultValue: true, sortable: true }),
  def('datetime', 'Data e hora', 'Momento no tempo.', 'ready', {
    defaultValue: false,
    sortable: true,
  }),
  def('email', 'Email', 'Endereço electrónico.', 'ready', {
    defaultValue: true,
    unique: true,
    searchable: true,
    sortable: true,
  }),
  def('phone', 'Telefone', 'Número de telefone.', 'ready', {
    defaultValue: true,
    unique: true,
    searchable: true,
  }),
  def('url', 'URL', 'Endereço web (http ou https).', 'ready', {
    defaultValue: true,
    searchable: true,
  }),
  def('select', 'Lista', 'Escolha única numa lista.', 'ready', {
    defaultValue: true,
    filterable: true,
    sortable: true,
    options: true,
  }),
  def('multiselect', 'Lista múltipla', 'Várias escolhas numa lista.', 'ready', {
    defaultValue: true,
    options: true,
  }),
  def('radio', 'Opções exclusivas', 'Escolha única com todas as opções visíveis.', 'ready', {
    defaultValue: true,
    filterable: true,
    sortable: true,
    options: true,
  }),
  def(
    'file',
    'Ficheiro',
    'Documento ou anexo (tipo e tamanho validados no servidor).',
    'ready',
    {},
  ),
  def('image', 'Imagem', 'Imagem (tipo e tamanho validados no servidor).', 'ready', {}),
  def(
    'entity-reference',
    'Referência a entidade',
    'Aponta para um registo de outra entidade.',
    'ready',
    { filterable: false, sortable: false },
  ),
  def(
    'user-reference',
    'Referência a utilizador',
    'Aponta para um utilizador do tenant.',
    'ready',
    {},
  ),
  def('formula', 'Fórmula', 'Valor calculado por uma expressão declarativa.', 'ready', {
    writable: false,
    required: false,
    listable: true,
    sortable: true,
  }),
  def('lookup', 'Valor relacionado', 'Valor lido de um registo referenciado.', 'preview', {
    writable: false,
    required: false,
  }),
  def(
    'auto-number',
    'Numeração automática',
    'Identificador sequencial atribuído pelo servidor.',
    'ready',
    {
      writable: false,
      required: false,
      unique: false,
      searchable: true,
      sortable: true,
    },
  ),
];

const byType = new Map(FIELD_TYPE_CATALOG.map((t) => [t.type, t]));

/** Um tipo que o catálogo não conhece (ex.: um tipo novo de um servidor mais recente). */
const UNKNOWN_CAPABILITIES: FieldCapabilities = {
  writable: false,
  defaultValue: false,
  required: false,
  unique: false,
  searchable: false,
  filterable: false,
  sortable: false,
  listable: true,
  exportable: false,
  options: false,
};

export const isKnownFieldType = (type: string): type is FieldType => byType.has(type as FieldType);

/**
 * Definição do tipo. Um tipo desconhecido não rebenta a aplicação: é tratado como só de leitura,
 * sem capacidades, e a verificação de integridade assinala-o.
 */
export function fieldTypeDefinition(type: FieldType): FieldTypeDefinition {
  return (
    byType.get(type) ?? {
      type,
      label: String(type),
      description: 'Tipo de campo desconhecido.',
      status: 'preview',
      capabilities: UNKNOWN_CAPABILITIES,
    }
  );
}

export function fieldCapabilities(type: FieldType): FieldCapabilities {
  return fieldTypeDefinition(type).capabilities;
}
