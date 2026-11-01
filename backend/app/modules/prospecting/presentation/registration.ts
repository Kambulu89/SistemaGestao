import {
  registerConsentGuard,
  registerNotificationRule,
  registerResourceLink,
} from '#modules/notifications/index'
import { prospectingServices } from '#modules/prospecting/presentation/composition'

let registered = false

/**
 * Liga a prospecção ao serviço de notificações (S02), sem ele a conhecer: pedir o contacto de uma campanha vira uma
 * mensagem promocional (com a guarda do consentimento no momento da entrega), converter uma lead avisa o responsável, e
 * as ligações das notificações abrem a oportunidade só a quem ainda tem acesso. Chamada uma vez no arranque.
 */
export function registerProspecting(): void {
  if (registered) return
  registered = true

  registerNotificationRule({
    code: 'crm.campaign.contact',
    eventTypes: ['crm.campaign.contact_requested'],
    async build(context, event) {
      const memberId = String(event.payload['memberId'] ?? '')
      const contact = await prospectingServices().campaigns.contactOf(context, memberId)
      if (!contact) return []
      const channel = contact.channel as 'EMAIL' | 'SMS' | 'WHATSAPP'
      return [
        {
          typeCode: 'crm.campaign.message',
          recipient: {},
          payload: { subject: contact.subject, message: contact.message },
          dedupeSuffix: memberId,
          resource: { type: 'campaign_member', id: memberId },
          channels: [channel],
          destinations: { [channel]: contact.destination },
        },
      ]
    },
  })

  registerNotificationRule({
    code: 'crm.lead.converted',
    eventTypes: ['crm.lead.converted'],
    async build(_context, event) {
      const owner = event.payload['ownerMembershipId']
      const opportunityId = event.payload['opportunityId']
      if (typeof owner !== 'string' || typeof opportunityId !== 'string') return []
      return [
        {
          typeCode: 'crm.lead.converted',
          recipient: { membershipId: owner },
          payload: {},
          dedupeSuffix: owner,
          resource: { type: 'opportunity', id: opportunityId },
        },
      ]
    },
  })

  registerConsentGuard('campaign_member', (context, memberId, channel, destination) =>
    prospectingServices().campaigns.isContactAllowed(
      context,
      memberId,
      channel as 'EMAIL' | 'SMS' | 'WHATSAPP',
      destination
    )
  )

  registerResourceLink('opportunity', {
    permission: 'crm.read',
    path: 'crm/pipeline',
    async exists(context, id) {
      try {
        await prospectingServices().opportunities.get(context, id)
        return true
      } catch {
        return false
      }
    },
  })
}
