type Validator = (value: unknown) => boolean

const oneOf =
  (...options: string[]): Validator =>
  (value) =>
    typeof value === 'string' && options.includes(value)

function isTimezone(value: unknown): boolean {
  if (typeof value !== 'string' || value.length > 64) return false
  try {
    new Intl.DateTimeFormat('en', { timeZone: value })
    return true
  } catch {
    return false
  }
}

/**
 * Lista **fechada** de preferências pessoais (spec C05: idioma, fuso de apresentação, notificações).
 * Impostos, moeda contabilística e limites de segurança não são preferências: não constam aqui, por
 * isso nunca podem ser alterados por este caminho.
 */
export const PREFERENCE_DEFINITIONS: Readonly<Record<string, Validator>> = {
  'ui.theme': oneOf('light', 'dark', 'system'),
  'ui.density': oneOf('compact', 'comfortable'),
  'ui.locale': (v) => typeof v === 'string' && /^[a-z]{2}(-[A-Z]{2})?$/.test(v),
  'ui.timezone': isTimezone,
  'notifications.email': (v) => typeof v === 'boolean',
  'notifications.digest': oneOf('off', 'daily', 'weekly'),
  'table.pageSize': (v) => Number.isInteger(v) && (v as number) >= 10 && (v as number) <= 100,
}

export const isKnownPreference = (key: string): boolean =>
  Object.hasOwn(PREFERENCE_DEFINITIONS, key)

export const isValidPreferenceValue = (key: string, value: unknown): boolean =>
  isKnownPreference(key) && PREFERENCE_DEFINITIONS[key](value)
