import app from '@adonisjs/core/services/app'
import logger from '@adonisjs/core/services/logger'
import env from '#start/env'

export interface MailMessage {
  to: string
  purpose: 'INVITATION' | 'PASSWORD_RESET'
  subject: string
  /** Ligação com o token; nunca vai para os logs. */
  link: string
}

/** `SENT_DEV`: guardado na caixa de desenvolvimento. `NOT_CONFIGURED`: não há fornecedor; nada foi enviado. */
export type DeliveryStatus = 'SENT_DEV' | 'NOT_CONFIGURED'

const devMailbox: MailMessage[] = []

export const devMailboxMessages = (): readonly MailMessage[] => [...devMailbox]
export const clearDevMailbox = () => {
  devMailbox.length = 0
}

/** Sem fornecedor de email escolhido (decisão pendente), não há envio real. */
export async function sendMail(message: MailMessage): Promise<DeliveryStatus> {
  const driver = env.get('MAIL_DRIVER') ?? 'none'
  if (driver === 'dev-memory' && !app.inProduction) {
    devMailbox.push(message)
    if (devMailbox.length > 200) devMailbox.shift()
    logger.info({ purpose: message.purpose }, 'Mensagem colocada na caixa de desenvolvimento.')
    return 'SENT_DEV'
  }
  logger.warn({ purpose: message.purpose }, 'MAIL_DRIVER=none: mensagem não enviada.')
  return 'NOT_CONFIGURED'
}
