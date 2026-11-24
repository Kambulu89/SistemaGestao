import type { ErrorDetail } from '#shared/http/api_error'
import { parseScaled, scaledText } from '#modules/sales/domain/pricing'

/*
 * Integração fiscal electrónica (10.9) — regras puras. Só SIMULAÇÃO.
 *
 *  - Fornecedores: o simulador local (disponível; não comunica com ninguém) e o adaptador oficial da AGT, registado mas
 *    bloqueado: a especificação técnica oficial (formato, assinatura JWS, serviços, códigos de resposta) não foi obtida
 *    nem verificada a partir deste ambiente, e o software não está certificado. Ver D-067.
 *  - O payload é um formato INTERNO (`SG-SIM-1`), não o formato oficial: serve para validar, fotografar e testar a fila.
 *  - Estados da submissão: QUEUED → SENDING → AWAITING → ACCEPTED | REJECTED; falhas transitórias voltam a QUEUED com
 *    espera crescente até ao máximo de tentativas (FAILED, repetível com motivo); INVALID quando a validação local
 *    falha (corrige-se com nota de crédito); CONTINGENCY quando emitido com a contingência activa (envia-se depois).
 */

export const PAYLOAD_FORMAT = 'SG-SIM-1'
export const PROVIDERS = ['LOCAL_SIMULATOR', 'AGT_OFFICIAL'] as const
export type ProviderCode = (typeof PROVIDERS)[number]
export const SCENARIOS = ['ACCEPT', 'REJECT', 'DELAYED', 'UNAVAILABLE'] as const
export type Scenario = (typeof SCENARIOS)[number]
export const SUBMISSION_STATUSES = [
  'QUEUED',
  'SENDING',
  'AWAITING',
  'ACCEPTED',
  'REJECTED',
  'FAILED',
  'INVALID',
  'CONTINGENCY',
] as const
export type SubmissionStatus = (typeof SUBMISSION_STATUSES)[number]

export const PROVIDER_INFO: Record<
  ProviderCode,
  { label: string; available: boolean; reason: string | null }
> = {
  LOCAL_SIMULATOR: {
    label: 'Simulador local — não comunica com a AGT',
    available: true,
    reason: null,
  },
  AGT_OFFICIAL: {
    label: 'AGT — serviço oficial de facturação electrónica',
    available: false,
    reason:
      'Indisponível: a especificação técnica oficial (formato, assinatura, serviços e respostas) não foi verificada e o software não está certificado. Nenhum documento é enviado à AGT.',
  },
}

/** Espera antes da próxima tentativa (minutos): 1, 2, 4, 8… até 60. */
export function retryDelayMinutes(failures: number) {
  return Math.min(60, 2 ** Math.max(0, failures - 1))
}

export interface PayloadLine {
  n: number
  description: string
  quantity: string | null
  unitPrice: string | null
  net: string
  taxes: {
    code: string
    kind: string
    rate: string
    base: string
    amount: string
    exemptionCode: string | null
  }[]
}

export interface FiscalPayload {
  format: string
  simulation: true
  documentType: string // código fiscal da série (FT, FR, NC, ND…)
  number: string
  date: string
  issuer: { taxId: string | null; name: string }
  customer: { taxId: string | null; name: string | null; countryCode: string | null }
  currency: string
  exchangeRate: string
  reference: { number: string; date: string } | null
  reason: string | null
  lines: PayloadLine[]
  totals: { net: string; tax: string; gross: string; withholding: string; payable: string }
  documentHash: string | null
}

const cents = (v: string) => parseScaled(v, 2) ?? 0n

/**
 * Validação local antes de enviar: dados obrigatórios e coerência dos totais. Não é a validação oficial da AGT (que
 * não foi obtida); apanha erros que nenhum serviço fiscal aceitaria.
 */
export function validatePayload(p: FiscalPayload, today: string): ErrorDetail[] {
  const issues: ErrorDetail[] = []
  const add = (path: string, code: string, message: string) => issues.push({ path, code, message })
  if (!p.number) add('number', 'REQUIRED', 'Documento sem número.')
  if (!p.documentType) add('documentType', 'REQUIRED', 'Série sem código fiscal.')
  if (!p.issuer.taxId) add('issuer.taxId', 'REQUIRED', 'A entidade emitente não tem NIF.')
  if (!p.customer.name) add('customer.name', 'REQUIRED', 'Cliente sem nome na fotografia fiscal.')
  if (!/^\d{4}-\d{2}-\d{2}$/.test(p.date) || p.date > today)
    add('date', 'INVALID', 'Data do documento inválida ou futura.')
  if (!/^[A-Z]{3}$/.test(p.currency)) add('currency', 'INVALID', 'Moeda inválida.')
  if (!p.lines.length) add('lines', 'REQUIRED', 'Documento sem linhas.')
  const net = p.lines.reduce((a, l) => a + cents(l.net), 0n)
  if (net !== cents(p.totals.net))
    add('totals.net', 'MISMATCH', `A soma das linhas (${scaledText(net, 2)}) não é o líquido.`)
  if (cents(p.totals.net) + cents(p.totals.tax) !== cents(p.totals.gross))
    add('totals.gross', 'MISMATCH', 'Bruto diferente de líquido + imposto.')
  if (cents(p.totals.gross) - cents(p.totals.withholding) !== cents(p.totals.payable))
    add('totals.payable', 'MISMATCH', 'A pagar diferente de bruto − retenção.')
  p.lines.forEach((l, i) => {
    for (const t of l.taxes)
      if (t.kind === 'TAX' && (parseScaled(t.rate, 4) ?? 0n) === 0n && !t.exemptionCode)
        add(
          `lines.${i}.taxes`,
          'EXEMPTION_REQUIRED',
          `Linha ${l.n}: taxa 0 % sem motivo de isenção.`
        )
  })
  if (['NC', 'ND'].includes(p.documentType) && !p.reference)
    add('reference', 'REQUIRED', 'A nota tem de referir o documento original.')
  return issues
}

/** Respostas do fornecedor (contrato comum a todos os adaptadores). */
export type SubmitResult =
  | { outcome: 'RECEIVED'; requestId: string; code: string; message: string }
  | { outcome: 'TRANSIENT'; code: string; message: string }
  | { outcome: 'REJECTED'; code: string; message: string; details?: unknown }
export type PollResult =
  | { outcome: 'PENDING'; code: string; message: string }
  | { outcome: 'ACCEPTED'; code: string; message: string; details?: unknown }
  | { outcome: 'REJECTED'; code: string; message: string; details?: unknown }
  | { outcome: 'TRANSIENT'; code: string; message: string }
