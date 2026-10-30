import { createHmac, timingSafeEqual } from 'node:crypto'
import type { SignedDownload, UrlSigner } from '#modules/documents/application/ports'

const b64 = (data: Buffer | string) => Buffer.from(data).toString('base64url')

/**
 * Tokens de descarga curtos: `carga.assinatura`, com HMAC-SHA-256 sobre uma chave derivada do segredo da aplicação
 * (separada das outras utilizações). Sem a chave não se forja nem se altera o tenant, o anexo ou o membro.
 */
export class HmacUrlSigner implements UrlSigner {
  private readonly key: Buffer

  constructor(secret: string) {
    this.key = createHmac('sha256', secret).update('documents:download-url:v1').digest()
  }

  private mac(payload: string): Buffer {
    return createHmac('sha256', this.key).update(payload).digest()
  }

  sign(payload: SignedDownload): string {
    const body = b64(
      JSON.stringify([
        payload.tenantId,
        payload.attachmentId,
        payload.membershipId,
        payload.userId,
        payload.expiresAt,
      ])
    )
    return `${body}.${b64(this.mac(body))}`
  }

  verify(token: string, now: Date): SignedDownload | null {
    const [body, signature, extra] = token.split('.')
    if (!body || !signature || extra !== undefined) return null
    const given = Buffer.from(signature, 'base64url')
    const expected = this.mac(body)
    if (given.length !== expected.length || !timingSafeEqual(given, expected)) return null
    try {
      const [tenantId, attachmentId, membershipId, userId, expiresAt] = JSON.parse(
        Buffer.from(body, 'base64url').toString('utf8')
      ) as [string, string, string, string, number]
      if (typeof expiresAt !== 'number' || expiresAt * 1000 < now.getTime()) return null
      return { tenantId, attachmentId, membershipId, userId, expiresAt }
    } catch {
      return null
    }
  }
}
