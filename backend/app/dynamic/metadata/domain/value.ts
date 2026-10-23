import {
  TEXTAREA_DEFAULT_MAX,
  TEXT_DEFAULT_MAX,
  decimalShape,
  type FieldSpec,
} from '#dynamic/metadata/domain/field_types'
import {
  normalizeEmail,
  normalizePhone,
  normalizeUrl,
  parseDate,
  parseDecimal,
  parseInstant,
} from '#dynamic/metadata/domain/scalars'

export type ValueResult =
  { ok: true; value: unknown } | { ok: false; code: string; message: string }

const fail = (code: string, message: string): ValueResult => ({ ok: false, code, message })
const ok = (value: unknown): ValueResult => ({ ok: true, value })

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i

/**
 * Valida e normaliza **um** valor contra a definição do campo (nunca executa nada do tenant).
 * `previous` é o valor já guardado: uma opção arquivada continua aceite se for o valor actual.
 * As referências só são verificadas em forma (UUID); a existência é verificada pela aplicação.
 */
export function validateValue(spec: FieldSpec, raw: unknown, previous: unknown): ValueResult {
  const v = spec.validation
  switch (spec.type) {
    case 'TEXT':
    case 'TEXTAREA': {
      if (typeof raw !== 'string') return fail('INVALID_TYPE', 'Indique texto.')
      const max =
        (v.maxLength as number | undefined) ??
        (spec.type === 'TEXT' ? TEXT_DEFAULT_MAX : TEXTAREA_DEFAULT_MAX)
      if (raw.length > max) return fail('TOO_LONG', `No máximo ${max} caracteres.`)
      if (raw.length < ((v.minLength as number | undefined) ?? 0)) {
        return fail('TOO_SHORT', `No mínimo ${v.minLength} caracteres.`)
      }
      if (typeof v.pattern === 'string' && !new RegExp(v.pattern, 'u').test(raw)) {
        return fail('PATTERN_MISMATCH', 'O valor não respeita o formato exigido.')
      }
      return ok(raw)
    }
    case 'NUMBER': {
      if (typeof raw !== 'number' || !Number.isSafeInteger(raw))
        return fail('INVALID_TYPE', 'Indique um inteiro.')
      if (typeof v.min === 'number' && raw < v.min) return fail('TOO_SMALL', `Mínimo ${v.min}.`)
      if (typeof v.max === 'number' && raw > v.max) return fail('TOO_LARGE', `Máximo ${v.max}.`)
      return ok(raw)
    }
    case 'DECIMAL': {
      if (typeof raw !== 'string')
        return fail('INVALID_TYPE', 'Indique o decimal em texto (ex.: "12.50").')
      const shape = decimalShape(v)
      const parsed = parseDecimal(raw, shape)
      if (!parsed.ok) return fail(parsed.code, parsed.message)
      for (const [key, below] of [
        ['min', true],
        ['max', false],
      ] as const) {
        if (typeof v[key] === 'string') {
          const bound = parseDecimal(v[key], shape)
          if (bound.ok && (below ? parsed.scaled < bound.scaled : parsed.scaled > bound.scaled)) {
            return fail(
              below ? 'TOO_SMALL' : 'TOO_LARGE',
              `${below ? 'Mínimo' : 'Máximo'} ${v[key]}.`
            )
          }
        }
      }
      return ok(parsed.canonical)
    }
    case 'BOOLEAN':
      return typeof raw === 'boolean'
        ? ok(raw)
        : fail('INVALID_TYPE', 'Indique verdadeiro ou falso.')
    case 'DATE':
    case 'DATETIME': {
      if (typeof raw !== 'string') return fail('INVALID_TYPE', 'Indique a data em texto.')
      const value = spec.type === 'DATE' ? parseDate(raw) : parseInstant(raw)
      if (!value) {
        return fail(
          'INVALID_DATE',
          spec.type === 'DATE'
            ? 'Data AAAA-MM-DD inválida.'
            : 'Instante ISO 8601 com fuso inválido.'
        )
      }
      if (typeof v.min === 'string' && value < v.min)
        return fail('TOO_SMALL', `Não anterior a ${v.min}.`)
      if (typeof v.max === 'string' && value > v.max)
        return fail('TOO_LARGE', `Não posterior a ${v.max}.`)
      return ok(value)
    }
    case 'EMAIL': {
      const value = typeof raw === 'string' ? normalizeEmail(raw) : null
      return value ? ok(value) : fail('INVALID_EMAIL', 'Email inválido.')
    }
    case 'PHONE': {
      const value = typeof raw === 'string' ? normalizePhone(raw) : null
      return value ? ok(value) : fail('INVALID_PHONE', 'Telefone inválido.')
    }
    case 'URL': {
      const value = typeof raw === 'string' ? normalizeUrl(raw) : null
      return value ? ok(value) : fail('INVALID_URL', 'Indique um endereço http(s) válido.')
    }
    case 'SELECT':
    case 'RADIO': {
      if (typeof raw !== 'string') return fail('INVALID_TYPE', 'Indique o código da opção.')
      const option = spec.options.find((o) => o.code === raw)
      if (!option || (option.archived && raw !== previous)) {
        return fail('INVALID_OPTION', 'Opção inexistente ou arquivada.')
      }
      return ok(raw)
    }
    case 'MULTISELECT': {
      if (!Array.isArray(raw) || raw.some((x) => typeof x !== 'string')) {
        return fail('INVALID_TYPE', 'Indique a lista de códigos de opções.')
      }
      if (new Set(raw).size !== raw.length) return fail('DUPLICATE_OPTION', 'Opções repetidas.')
      const kept = Array.isArray(previous) ? previous : []
      for (const code of raw as string[]) {
        const option = spec.options.find((o) => o.code === code)
        if (!option || (option.archived && !kept.includes(code))) {
          return fail('INVALID_OPTION', `Opção "${code}" inexistente ou arquivada.`)
        }
      }
      const min = (v.minSelected as number | undefined) ?? 0
      const max = (v.maxSelected as number | undefined) ?? raw.length
      if (raw.length < min) return fail('TOO_FEW', `Escolha pelo menos ${min}.`)
      if (raw.length > max) return fail('TOO_MANY', `Escolha no máximo ${max}.`)
      return ok([...(raw as string[])].sort())
    }
    case 'FORMULA':
      return fail('READ_ONLY', 'O resultado de uma fórmula é calculado pelo servidor.')
    case 'LOOKUP':
      return fail('READ_ONLY', 'Um valor relacionado é lido do registo de origem.')
    case 'ENTITY_REFERENCE':
    case 'USER_REFERENCE':
      return typeof raw === 'string' && UUID.test(raw)
        ? ok(raw.toLowerCase())
        : fail('INVALID_REFERENCE', 'Indique o identificador (UUID).')
  }
}
