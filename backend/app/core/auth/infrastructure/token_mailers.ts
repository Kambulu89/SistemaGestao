import redis from '@adonisjs/redis/services/main'
import logger from '@adonisjs/core/services/logger'
import type { TokenMailer, TokenMessage } from '#core/auth/application/ports'

export const DEV_MAILBOX_KEY = 'dev:mailbox'

/**
 * Só desenvolvimento e testes: guarda a mensagem numa lista do Redis para ser lida por um script ou
 * teste. Proibido em produção (`assertEnvConsistency`). Os logs nunca incluem o token.
 */
export class DevRedisTokenMailer implements TokenMailer {
  async send(message: TokenMessage) {
    await redis.rpush(
      DEV_MAILBOX_KEY,
      JSON.stringify({ ...message, expiresAt: message.expiresAt.toISOString() })
    )
    await redis.ltrim(DEV_MAILBOX_KEY, -200, -1)
    logger.info(
      { purpose: message.purpose },
      'Mensagem de token colocada na caixa de desenvolvimento.'
    )
  }
}

/** Sem fornecedor de email configurado: não entrega nada e avisa (sem token nem destinatário). */
export class NoopTokenMailer implements TokenMailer {
  async send(message: TokenMessage) {
    logger.warn({ purpose: message.purpose }, 'MAIL_DRIVER=none: a mensagem não foi entregue.')
  }
}
