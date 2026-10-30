import { SettingsRuleError } from '#core/settings/domain/errors'

const DATE = /^\d{4}-\d{2}-\d{2}$/
const RATE = /^\d{1,5}(\.\d{1,4})?$/
const CODE = /^[A-Z][A-Z0-9_.-]{0,39}$/

export function isValidDate(value: string): boolean {
  if (!DATE.test(value)) return false
  const d = new Date(`${value}T00:00:00Z`)
  return !Number.isNaN(d.getTime()) && d.toISOString().startsWith(value)
}

export function validateTaxRate(input: {
  code: string
  rate: string
  validFrom: string
  validTo: string | null
  category: string
  exemptionReason: string | null
}): void {
  if (!CODE.test(input.code)) {
    throw new SettingsRuleError(
      'code',
      'INVALID_CODE',
      'Código: maiúsculas, dígitos e _.- (máx. 40).'
    )
  }
  if (!RATE.test(input.rate)) {
    throw new SettingsRuleError('rate', 'INVALID_RATE', 'A taxa é um decimal ≥ 0 com até 4 casas.')
  }
  if (!isValidDate(input.validFrom) || (input.validTo !== null && !isValidDate(input.validTo))) {
    throw new SettingsRuleError('validFrom', 'INVALID_DATE', 'Datas no formato AAAA-MM-DD.')
  }
  if (input.validTo !== null && input.validTo < input.validFrom) {
    throw new SettingsRuleError(
      'validTo',
      'INVALID_PERIOD',
      'O fim não pode ser anterior ao início.'
    )
  }
  if (!input.category.trim() || input.category.length > 50) {
    throw new SettingsRuleError(
      'category',
      'INVALID_CATEGORY',
      'A categoria é obrigatória (máx. 50).'
    )
  }
  if (Number(input.rate) === 0 && !input.exemptionReason?.trim()) {
    throw new SettingsRuleError(
      'exemptionReason',
      'EXEMPTION_REASON_REQUIRED',
      'Uma taxa zero exige o motivo da isenção.'
    )
  }
}
