/*
|--------------------------------------------------------------------------
| Conectores de comunicação
|--------------------------------------------------------------------------
|
| Cada canal externo (email, SMS, WhatsApp) só entrega quando tem um conector real, configurado por ambiente
| (`NOTIFICATIONS_<CANAL>_URL`, ver `.env.example`). Sem URL, uma entrega externa falha com `PROVIDER_NOT_CONFIGURED`
| (e repete-se por decisão de quem administra depois de configurado): nunca finge que enviou. O fornecedor de cada canal é
| uma decisão de produto ainda em aberto (especificação §11.2). O canal interno não precisa de conector.
*/

import env from '#start/env'
import { registerChannelProvider } from '#modules/notifications/index'
import { HttpGatewayProvider } from '#modules/notifications/infrastructure/http_gateway_provider'

export function registerMessagingProviders(): void {
  const channels = [
    ['EMAIL', 'email_http', 'NOTIFICATIONS_EMAIL'],
    ['SMS', 'sms_http', 'NOTIFICATIONS_SMS'],
    ['WHATSAPP', 'whatsapp_http', 'NOTIFICATIONS_WHATSAPP'],
  ] as const
  for (const [channel, name, prefix] of channels) {
    const url = env.get(`${prefix}_URL`)
    if (!url) continue
    registerChannelProvider(
      new HttpGatewayProvider({
        channel,
        name,
        url,
        token: env.get(`${prefix}_TOKEN`) ?? null,
        supportsDedupe: env.get(`${prefix}_DEDUPE`) ?? false,
      })
    )
  }
}
