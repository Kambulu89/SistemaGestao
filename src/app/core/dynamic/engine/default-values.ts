import {
  activeOptions,
  hasOptions,
  type FieldDefinition,
  type FieldValue,
} from '../models/field-definition.model';
import type { DefaultValueSpec } from '../models/form-definition.model';

/** O que os resolvers conhecem do momento e do contexto de quem preenche. */
export interface DefaultContext {
  /** Dia actual, `AAAA-MM-DD`. */
  readonly today: string;
  /** Momento actual, ISO 8601. */
  readonly now: string;
  readonly user: { readonly id: string; readonly name: string; readonly email: string } | null;
  readonly tenant: { readonly id: string; readonly name: string } | null;
}

export function defaultContextAt(
  at: Date,
  user: DefaultContext['user'],
  tenant: DefaultContext['tenant'],
): DefaultContext {
  const now = at.toISOString();
  return { today: now.slice(0, 10), now, user, tenant };
}

/** Valor de um resolver. Sem utilizador/tenant, os resolvers que deles dependem dão vazio. */
export function resolveDefaultValue(spec: DefaultValueSpec, context: DefaultContext): FieldValue {
  switch (spec.kind) {
    case 'fixed':
      return Array.isArray(spec.value)
        ? [...(spec.value as readonly string[])]
        : (spec.value as FieldValue);
    case 'today':
      return context.today;
    case 'now':
      return context.now;
    case 'currentUser':
      return context.user ? context.user[spec.as] : null;
    case 'currentTenant':
      return context.tenant ? context.tenant[spec.as] : null;
  }
}

const TEXT_LIKE = new Set(['text', 'textarea', 'email', 'phone', 'url']);
const NUMERIC = new Set(['number', 'decimal', 'currency']);
const NOT_WRITABLE_MESSAGE = 'Um campo atribuído pelo servidor não tem valor por omissão.';

/**
 * Verifica se um resolver é compatível com o tipo do campo. Devolve a mensagem do problema,
 * ou `null` se estiver correcto. Não se aceitam valores que o campo não aceitaria.
 */
export function defaultSpecIssue(spec: DefaultValueSpec, field: FieldDefinition): string | null {
  if (['formula', 'lookup', 'auto-number'].includes(field.type)) return NOT_WRITABLE_MESSAGE;
  if (['file', 'image', 'entity-reference'].includes(field.type))
    return `O tipo "${field.type}" não admite valor por omissão.`;

  switch (spec.kind) {
    case 'today':
      return field.type === 'date' ? null : '«Data actual» só se aplica a campos de data.';
    case 'now':
      return field.type === 'datetime'
        ? null
        : '«Momento actual» só se aplica a campos de data e hora.';
    case 'currentUser':
      if (field.type === 'user-reference')
        return spec.as === 'id' ? null : 'Uma referência a utilizador recebe o identificador.';
      return TEXT_LIKE.has(field.type) && !(spec.as === 'email' && field.type === 'phone')
        ? null
        : '«Utilizador autenticado» aplica-se a referências a utilizador ou a texto.';
    case 'currentTenant':
      return TEXT_LIKE.has(field.type) ? null : '«Tenant activo» aplica-se a campos de texto.';
    case 'fixed':
      return fixedIssue(spec.value, field);
  }
}

function fixedIssue(value: unknown, field: FieldDefinition): string | null {
  const wrong = `O valor por omissão não é válido para o tipo "${field.type}".`;
  if (field.type === 'user-reference')
    return 'Use «Utilizador autenticado»: um utilizador fixo não é portável.';
  if (hasOptions(field)) {
    const valid = new Set(activeOptions(field).map((o) => o.value));
    const values = field.type === 'multiselect' ? value : [value];
    if (!Array.isArray(values) || values.some((v) => typeof v !== 'string')) return wrong;
    return (values as string[]).every((v) => valid.has(v))
      ? null
      : 'O valor por omissão não é uma das opções activas.';
  }
  if (TEXT_LIKE.has(field.type)) return typeof value === 'string' ? null : wrong;
  if (NUMERIC.has(field.type))
    return typeof value === 'number' && Number.isFinite(value) ? null : wrong;
  if (field.type === 'boolean' || field.type === 'checkbox')
    return typeof value === 'boolean' ? null : wrong;
  if (field.type === 'date')
    return typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value) ? null : wrong;
  return wrong;
}
