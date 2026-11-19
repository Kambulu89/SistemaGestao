/**
 * Transferências (8.5). Rascunho → pedida → aprovada (reserva na origem) → separada → em trânsito (sai da origem, fica
 * em trânsito no destino) → recebida parcial/total (sai do trânsito, entra no destino). Entre entidades legais
 * (intragrupo) a aprovação da origem não basta: o destino aceita e há referência do documento comercial antes da
 * expedição. O que não chega fecha-se como perda em trânsito, com motivo.
 */
export const TRANSFER_STATUSES = [
  'DRAFT',
  'REQUESTED',
  'APPROVED',
  'PICKED',
  'IN_TRANSIT',
  'PARTIAL',
  'RECEIVED',
  'REJECTED',
  'CANCELLED',
] as const
export type TransferStatus = (typeof TRANSFER_STATUSES)[number]

/** Série documental das transferências (da entidade legal de origem). */
export const TRANSFER_SERIES_TYPE = 'STOCK_TRANSFER'

export const TRANSFER_CAN: Record<
  | 'edit'
  | 'submit'
  | 'approve'
  | 'accept'
  | 'reject'
  | 'pick'
  | 'dispatch'
  | 'receive'
  | 'close'
  | 'cancel',
  readonly TransferStatus[]
> = {
  edit: ['DRAFT'],
  submit: ['DRAFT'],
  approve: ['REQUESTED'],
  accept: ['REQUESTED'],
  reject: ['REQUESTED'],
  pick: ['APPROVED', 'PICKED'],
  dispatch: ['APPROVED', 'PICKED'],
  receive: ['IN_TRANSIT', 'PARTIAL'],
  close: ['IN_TRANSIT', 'PARTIAL'],
  cancel: ['DRAFT', 'REQUESTED', 'APPROVED', 'PICKED'],
}

/** A aprovação está completa? Intragrupo exige também a aceitação do destino. */
export const approvalComplete = (t: {
  intercompany: boolean
  approved: boolean
  accepted: boolean
}) => t.approved && (!t.intercompany || t.accepted)

/** Quem pediu não aprova nem aceita o próprio pedido (segregação de funções). */
export const selfApproval = (requestedBy: string | null, userId: string) =>
  !!requestedBy && requestedBy === userId

/** Estado depois de uma recepção ou perda: tudo o que foi expedido está resolvido → recebida. */
export function statusAfterReceipt(
  lines: { shipped: bigint; received: bigint; lost: bigint }[]
): TransferStatus {
  const done = lines.every((l) => l.received + l.lost === l.shipped)
  if (done) return 'RECEIVED'
  return 'PARTIAL'
}

/** Quantidade a expedir: a separada (se houver separação) ou a pedida. */
export const toShip = (l: { quantity: bigint; picked: bigint | null }) =>
  l.picked === null ? l.quantity : l.picked

/** Recepção de uma linha: positiva e até ao que ainda está em trânsito. */
export function receiveIssue(quantity: bigint, inTransit: bigint): string | null {
  if (quantity < 0n) return 'Quantidade negativa.'
  if (quantity > inTransit) return 'Recebido acima do que está em trânsito nesta linha.'
  return null
}
