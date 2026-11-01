import { randomUUID } from 'node:crypto'

export const CORRELATION_HEADER = 'x-correlation-id'

/** Formato aceite para um correlation id vindo do exterior: curto e sem caracteres de controlo. */
const VALID_INCOMING = /^[A-Za-z0-9][A-Za-z0-9._-]{7,63}$/

/**
 * O correlation id é decidido pelo servidor: um valor recebido só é reutilizado se tiver o formato
 * esperado (permite seguir um pedido entre serviços); caso contrário gera-se um novo UUID. Isto
 * impede injecção de conteúdo arbitrário em logs e cabeçalhos.
 */
export function resolveCorrelationId(incoming: string | undefined | null): string {
  if (incoming && VALID_INCOMING.test(incoming)) return incoming
  return randomUUID()
}
