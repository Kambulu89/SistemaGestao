import {
  hasOptions,
  type FieldDefinition,
  type FieldValue,
} from '../models/field-definition.model';

const EMPTY = '—';

/**
 * Texto de apresentação de um valor, a partir do tipo do campo. Partilhado pelos renderers
 * (leitura de formulários, células de listagens) e preparado para relatórios.
 * Referências mostram o id: quem tem os rótulos (repositório) resolve-os à parte.
 */
export function formatFieldValue(
  field: FieldDefinition,
  value: FieldValue | undefined,
  locale = 'pt-PT',
): string {
  if (
    value === null ||
    value === undefined ||
    value === '' ||
    (Array.isArray(value) && value.length === 0)
  ) {
    return EMPTY;
  }

  if (field.type === 'lookup') {
    // O valor é do campo de origem: formata-se como ele (data, moeda, opção…).
    const source = field.lookup.resolvedSource;
    return source
      ? formatFieldValue(source, value, locale)
      : value === true
        ? 'Sim'
        : value === false
          ? 'Não'
          : String(value);
  }

  if (hasOptions(field)) {
    const label = (v: string) => field.options.find((o) => o.value === v)?.label ?? v;
    return Array.isArray(value)
      ? (value as readonly string[]).map(label).join(', ')
      : label(String(value));
  }

  switch (field.type) {
    case 'boolean':
    case 'checkbox':
      return value === true ? 'Sim' : 'Não';
    case 'number':
      return typeof value === 'number'
        ? new Intl.NumberFormat(locale).format(value)
        : String(value);
    case 'decimal':
    case 'formula':
      return typeof value === 'number'
        ? new Intl.NumberFormat(locale, {
            minimumFractionDigits: field.scale ?? 0,
            maximumFractionDigits: field.scale ?? 20,
          }).format(value)
        : String(value);
    case 'currency':
      return typeof value === 'number'
        ? new Intl.NumberFormat(locale, {
            style: 'currency',
            currency: field.currency,
            minimumFractionDigits: field.scale ?? 2,
            maximumFractionDigits: field.scale ?? 2,
          }).format(value)
        : String(value);
    case 'date':
      return typeof value === 'string'
        ? new Intl.DateTimeFormat(locale, { dateStyle: 'medium', timeZone: 'UTC' }).format(
            new Date(value),
          )
        : String(value);
    case 'datetime':
      return typeof value === 'string'
        ? new Intl.DateTimeFormat(locale, { dateStyle: 'medium', timeStyle: 'short' }).format(
            new Date(value),
          )
        : String(value);
    case 'file':
    case 'image':
      return (value as readonly { name: string }[]).map((f) => f.name).join(', ');
    default:
      return String(value);
  }
}
