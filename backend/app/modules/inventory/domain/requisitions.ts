/**
 * Requisições internas (8.6). Rascunho → pedida → aprovada (reserva: o reservado baixa o disponível, não o físico) →
 * separada → entregue parcial → concluída. O que já não é preciso liberta-se (com motivo); anular depois de aprovada
 * liberta a reserva toda. Quem pede não aprova.
 */
export const REQUISITION_STATUSES = [
  'DRAFT',
  'REQUESTED',
  'APPROVED',
  'PICKED',
  'PARTIAL',
  'COMPLETED',
  'REJECTED',
  'CANCELLED',
] as const
export type RequisitionStatus = (typeof REQUISITION_STATUSES)[number]

export const REQUISITION_SERIES_TYPE = 'STOCK_REQUISITION'

export const REQUISITION_CAN: Record<
  'edit' | 'submit' | 'approve' | 'reject' | 'pick' | 'issue' | 'release' | 'cancel',
  readonly RequisitionStatus[]
> = {
  edit: ['DRAFT'],
  submit: ['DRAFT'],
  approve: ['REQUESTED'],
  reject: ['REQUESTED'],
  pick: ['APPROVED', 'PICKED', 'PARTIAL'],
  issue: ['APPROVED', 'PICKED', 'PARTIAL'],
  release: ['APPROVED', 'PICKED', 'PARTIAL'],
  cancel: ['DRAFT', 'REQUESTED', 'APPROVED', 'PICKED'],
}

/** Em aberto numa linha: pedido − entregue − libertado (é o que continua reservado). */
export const openQuantity = (l: { quantity: bigint; issued: bigint; released: bigint }) =>
  l.quantity - l.issued - l.released

/** Entrega de uma linha: positiva, até ao que está em aberto e, havendo separação, até ao separado por entregar. */
export function issueIssue(
  q: bigint,
  l: { quantity: bigint; issued: bigint; released: bigint; picked: bigint | null }
): string | null {
  if (q <= 0n) return 'Quantidade positiva.'
  if (q > openQuantity(l)) return 'Acima do que está em aberto nesta linha.'
  if (l.picked !== null && l.issued + q > l.picked)
    return 'Acima do que foi separado: registe primeiro a separação.'
  return null
}

/** Estado depois de uma entrega ou libertação: tudo resolvido → concluída; senão, parcial. */
export function statusAfterIssue(
  lines: { quantity: bigint; issued: bigint; released: bigint }[]
): RequisitionStatus {
  return lines.every((l) => openQuantity(l) === 0n) ? 'COMPLETED' : 'PARTIAL'
}

/** Âmbito RBAC que cobre um departamento (directamente, pela filial ou pela entidade legal). */
export function coversDepartment(
  s: {
    tenant: boolean
    legalEntityIds: Set<string>
    branchIds: Set<string>
    departmentIds: Set<string>
  },
  d: { id: string; legalEntityId: string; branchId: string | null }
) {
  return (
    s.tenant ||
    s.legalEntityIds.has(d.legalEntityId) ||
    (!!d.branchId && s.branchIds.has(d.branchId)) ||
    s.departmentIds.has(d.id)
  )
}
