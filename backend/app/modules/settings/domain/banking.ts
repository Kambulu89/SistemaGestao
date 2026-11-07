/**
 * Validação de identificadores bancários (formato apenas; não confirma que a conta existe).
 *  - IBAN: ISO 13616, verificação mod 97 (a mesma regra para todos os países; Angola usa "AO" + 23 caracteres).
 *  - SWIFT/BIC: ISO 9362, 8 ou 11 caracteres.
 */
export function normalizeIban(raw: string): string {
  return raw.replace(/\s+/g, '').toUpperCase()
}

export function isValidIban(raw: string): boolean {
  const iban = normalizeIban(raw)
  if (!/^[A-Z]{2}\d{2}[A-Z0-9]{11,30}$/.test(iban)) return false
  const rearranged = iban.slice(4) + iban.slice(0, 4)
  const digits = rearranged.replace(/[A-Z]/g, (c) => String(c.charCodeAt(0) - 55))
  let remainder = 0
  for (const ch of digits) remainder = (remainder * 10 + Number(ch)) % 97
  return remainder === 1
}

export function isValidSwift(raw: string): boolean {
  return /^[A-Z]{4}[A-Z]{2}[A-Z0-9]{2}([A-Z0-9]{3})?$/.test(raw.trim().toUpperCase())
}

/** Mostra só os últimos 4 caracteres (listas e notificações). */
export function maskIban(iban: string | null): string | null {
  if (!iban) return null
  return `${iban.slice(0, 4)} •••• ${iban.slice(-4)}`
}
