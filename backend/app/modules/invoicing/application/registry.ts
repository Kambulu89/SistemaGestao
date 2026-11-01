import type { TenantScope } from '#core/tenancy/index'
import type { CreditNote, Invoice } from '#modules/invoicing/application/ports'

/** Efeitos de emitir uma factura ou uma nota de crédito, na **mesma transacção** (recebível, crédito aplicado…). */
export interface InvoiceEffects {
  /** Depois de a factura ficar emitida; lançar um erro anula a emissão por inteiro (e o número gasto volta). */
  issued?(scope: TenantScope, invoice: Invoice): Promise<void>
  /** Depois de a nota de crédito ficar emitida (a factura de origem já reflecte o estado `CREDITED`, se for o caso). */
  creditNoteIssued?(scope: TenantScope, note: CreditNote, invoice: Invoice): Promise<void>
}

const effects: InvoiceEffects[] = []

/**
 * As finanças registam aqui o recebível criado ao emitir e o crédito aplicado ao emitir uma nota. A facturação não
 * depende das finanças: sem nenhum efeito registado, emitir só emite. Devolve a função que o retira.
 */
export function registerInvoiceEffects(effect: InvoiceEffects): () => void {
  effects.push(effect)
  return () => {
    const at = effects.indexOf(effect)
    if (at >= 0) effects.splice(at, 1)
  }
}

export async function runIssuedEffects(scope: TenantScope, invoice: Invoice): Promise<void> {
  for (const effect of effects) await effect.issued?.(scope, invoice)
}

export async function runCreditNoteEffects(
  scope: TenantScope,
  note: CreditNote,
  invoice: Invoice
): Promise<void> {
  for (const effect of effects) await effect.creditNoteIssued?.(scope, note, invoice)
}
