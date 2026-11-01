import { createCipheriv, createDecipheriv, randomBytes, scryptSync } from 'node:crypto'
import type { Cipher } from '#modules/notifications/application/ports'

const VERSION = 'v1'

/**
 * Cifra os destinos externos (email, telefone) em repouso com AES-256-GCM. A chave deriva da `APP_KEY` com um sal fixo
 * próprio deste uso; cada valor leva o seu IV aleatório e a etiqueta de autenticação (qualquer alteração falha ao decifrar).
 */
export class AesGcmCipher implements Cipher {
  private readonly key: Buffer

  constructor(secret: string) {
    this.key = scryptSync(secret, 'notification-destination', 32)
  }

  encrypt(plain: string): string {
    const iv = randomBytes(12)
    const cipher = createCipheriv('aes-256-gcm', this.key, iv)
    const data = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()])
    return [
      VERSION,
      iv.toString('base64'),
      cipher.getAuthTag().toString('base64'),
      data.toString('base64'),
    ].join(':')
  }

  decrypt(encoded: string): string {
    const [version, iv, tag, data] = encoded.split(':')
    if (version !== VERSION || !iv || !tag || !data) throw new Error('Destino cifrado inválido.')
    const decipher = createDecipheriv('aes-256-gcm', this.key, Buffer.from(iv, 'base64'))
    decipher.setAuthTag(Buffer.from(tag, 'base64'))
    return Buffer.concat([decipher.update(Buffer.from(data, 'base64')), decipher.final()]).toString(
      'utf8'
    )
  }
}
