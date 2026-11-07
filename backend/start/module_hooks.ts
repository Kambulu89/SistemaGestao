/*
| Ligações entre módulos registadas no arranque (para não criar importações circulares):
| - efeito da conclusão de aprovações de contas bancárias (configurações);
| - filtro de notificações pelas configurações da empresa.
*/
import { registerSubjectHandler } from '#modules/approvals/index'
import { registerNotificationFilter } from '#modules/notifications/index'
import { onBankAccountDecided, tenantSettings } from '#modules/settings/index'

registerSubjectHandler('bank_account', onBankAccountDecided)

registerNotificationFilter(async (scope, type) => {
  const settings = await tenantSettings(scope)
  if (type === 'approval.pending') return settings.notifyApprovalPending
  if (type === 'approval.approved' || type === 'approval.rejected')
    return settings.notifyApprovalDecided
  return true
})
