import '@adonisjs/core/types/http'

type ParamValue = string | number | bigint | boolean

export type ScannedRoutes = {
  ALL: {
    'health.show': { paramsTuple?: []; params?: {} }
    'auth.login': { paramsTuple?: []; params?: {} }
    'account.forgot_password': { paramsTuple?: []; params?: {} }
    'account.reset_password': { paramsTuple?: []; params?: {} }
    'invitation.accept': { paramsTuple?: []; params?: {} }
    'auth.me': { paramsTuple?: []; params?: {} }
    'auth.logout': { paramsTuple?: []; params?: {} }
    'account.sessions': { paramsTuple?: []; params?: {} }
    'account.revoke_session': { paramsTuple: [ParamValue]; params: {'id': ParamValue} }
    'roles.permissions': { paramsTuple?: []; params?: {} }
    'context.show': { paramsTuple?: []; params?: {} }
    'roles.mine': { paramsTuple?: []; params?: {} }
    'roles.index': { paramsTuple?: []; params?: {} }
    'roles.show': { paramsTuple: [ParamValue]; params: {'id': ParamValue} }
    'roles.store': { paramsTuple?: []; params?: {} }
    'roles.update': { paramsTuple: [ParamValue]; params: {'id': ParamValue} }
    'roles.destroy': { paramsTuple: [ParamValue]; params: {'id': ParamValue} }
    'members.index': { paramsTuple?: []; params?: {} }
    'members.show': { paramsTuple: [ParamValue]; params: {'id': ParamValue} }
    'members.invite': { paramsTuple?: []; params?: {} }
    'members.resend_invitation': { paramsTuple: [ParamValue]; params: {'id': ParamValue} }
    'members.revoke_invitation': { paramsTuple: [ParamValue]; params: {'id': ParamValue} }
    'members.suspend': { paramsTuple: [ParamValue]; params: {'id': ParamValue} }
    'members.reactivate': { paramsTuple: [ParamValue]; params: {'id': ParamValue} }
    'members.assign_role': { paramsTuple: [ParamValue]; params: {'id': ParamValue} }
    'members.unassign_role': { paramsTuple: [ParamValue,ParamValue]; params: {'id': ParamValue,'assignmentId': ParamValue} }
    'organization.index': { paramsTuple: [ParamValue]; params: {'kind': ParamValue} }
    'organization.tree': { paramsTuple: [ParamValue]; params: {'kind': ParamValue} }
    'organization.show': { paramsTuple: [ParamValue,ParamValue]; params: {'kind': ParamValue,'id': ParamValue} }
    'organization.dependents': { paramsTuple: [ParamValue,ParamValue]; params: {'kind': ParamValue,'id': ParamValue} }
    'organization.store': { paramsTuple: [ParamValue]; params: {'kind': ParamValue} }
    'organization.update': { paramsTuple: [ParamValue,ParamValue]; params: {'kind': ParamValue,'id': ParamValue} }
    'tenant_subscription.show': { paramsTuple?: []; params?: {} }
    'settings.profile': { paramsTuple?: []; params?: {} }
    'settings.settings': { paramsTuple?: []; params?: {} }
    'exchange_rates.index': { paramsTuple?: []; params?: {} }
    'settings.lookup_rate': { paramsTuple?: []; params?: {} }
    'exchange_rates.show': { paramsTuple: [ParamValue]; params: {'id': ParamValue} }
    'document_series.index': { paramsTuple?: []; params?: {} }
    'document_series.show': { paramsTuple: [ParamValue]; params: {'id': ParamValue} }
    'settings.preview_series': { paramsTuple: [ParamValue]; params: {'id': ParamValue} }
    'calendars.index': { paramsTuple?: []; params?: {} }
    'calendars.show': { paramsTuple: [ParamValue]; params: {'id': ParamValue} }
    'settings.working_days': { paramsTuple: [ParamValue]; params: {'id': ParamValue} }
    'settings.update_profile': { paramsTuple?: []; params?: {} }
    'settings.update_settings': { paramsTuple?: []; params?: {} }
    'exchange_rates.store': { paramsTuple?: []; params?: {} }
    'exchange_rates.update': { paramsTuple: [ParamValue]; params: {'id': ParamValue} }
    'document_series.store': { paramsTuple?: []; params?: {} }
    'document_series.update': { paramsTuple: [ParamValue]; params: {'id': ParamValue} }
    'calendars.store': { paramsTuple?: []; params?: {} }
    'calendars.update': { paramsTuple: [ParamValue]; params: {'id': ParamValue} }
    'settings.add_holiday': { paramsTuple: [ParamValue]; params: {'id': ParamValue} }
    'settings.remove_holiday': { paramsTuple: [ParamValue,ParamValue]; params: {'id': ParamValue,'holidayId': ParamValue} }
    'bank_accounts.index': { paramsTuple?: []; params?: {} }
    'bank_accounts.show': { paramsTuple: [ParamValue]; params: {'id': ParamValue} }
    'bank_accounts.store': { paramsTuple?: []; params?: {} }
    'bank_accounts.update': { paramsTuple: [ParamValue]; params: {'id': ParamValue} }
    'accounting.charts.index': { paramsTuple?: []; params?: {} }
    'accounting.charts.show': { paramsTuple: [ParamValue]; params: {'id': ParamValue} }
    'accounting.accounts.index': { paramsTuple?: []; params?: {} }
    'accounting.accounts.show': { paramsTuple: [ParamValue]; params: {'id': ParamValue} }
    'accounting.fiscal_years.index': { paramsTuple?: []; params?: {} }
    'accounting.fiscal_years.show': { paramsTuple: [ParamValue]; params: {'id': ParamValue} }
    'accounting.journals.index': { paramsTuple?: []; params?: {} }
    'accounting.journals.show': { paramsTuple: [ParamValue]; params: {'id': ParamValue} }
    'accounting.entries': { paramsTuple?: []; params?: {} }
    'accounting.entry': { paramsTuple: [ParamValue]; params: {'id': ParamValue} }
    'accounting.charts.store': { paramsTuple?: []; params?: {} }
    'accounting.charts.update': { paramsTuple: [ParamValue]; params: {'id': ParamValue} }
    'accounting.accounts.store': { paramsTuple?: []; params?: {} }
    'accounting.accounts.update': { paramsTuple: [ParamValue]; params: {'id': ParamValue} }
    'accounting.fiscal_years.store': { paramsTuple?: []; params?: {} }
    'accounting.fiscal_years.update': { paramsTuple: [ParamValue]; params: {'id': ParamValue} }
    'accounting.journals.store': { paramsTuple?: []; params?: {} }
    'accounting.journals.update': { paramsTuple: [ParamValue]; params: {'id': ParamValue} }
    'accounting.close_period': { paramsTuple: [ParamValue]; params: {'id': ParamValue} }
    'accounting.reopen_period': { paramsTuple: [ParamValue]; params: {'id': ParamValue} }
    'accounting.create_entry': { paramsTuple?: []; params?: {} }
    'accounting.update_entry': { paramsTuple: [ParamValue]; params: {'id': ParamValue} }
    'accounting.delete_entry': { paramsTuple: [ParamValue]; params: {'id': ParamValue} }
    'accounting.submit': { paramsTuple: [ParamValue]; params: {'id': ParamValue} }
    'accounting.approve': { paramsTuple: [ParamValue]; params: {'id': ParamValue} }
    'accounting.reject': { paramsTuple: [ParamValue]; params: {'id': ParamValue} }
    'accounting.post': { paramsTuple: [ParamValue]; params: {'id': ParamValue} }
    'accounting.reverse': { paramsTuple: [ParamValue]; params: {'id': ParamValue} }
    'audit.index': { paramsTuple?: []; params?: {} }
    'notifications.index': { paramsTuple?: []; params?: {} }
    'notifications.read_all': { paramsTuple?: []; params?: {} }
    'notifications.read': { paramsTuple: [ParamValue]; params: {'id': ParamValue} }
    'tasks.index': { paramsTuple?: []; params?: {} }
    'dashboard.summary': { paramsTuple?: []; params?: {} }
    'dashboard.search': { paramsTuple?: []; params?: {} }
    'approvals.workflows': { paramsTuple?: []; params?: {} }
    'approvals.create_workflow': { paramsTuple?: []; params?: {} }
    'approvals.workflow': { paramsTuple: [ParamValue]; params: {'id': ParamValue} }
    'approvals.update_workflow': { paramsTuple: [ParamValue]; params: {'id': ParamValue} }
    'approvals.delete_workflow': { paramsTuple: [ParamValue]; params: {'id': ParamValue} }
    'approvals.publish_workflow': { paramsTuple: [ParamValue]; params: {'id': ParamValue} }
    'approvals.retire_workflow': { paramsTuple: [ParamValue]; params: {'id': ParamValue} }
    'approvals.active_workflows': { paramsTuple?: []; params?: {} }
    'approvals.submit': { paramsTuple?: []; params?: {} }
    'approvals.requests': { paramsTuple?: []; params?: {} }
    'approvals.request': { paramsTuple: [ParamValue]; params: {'id': ParamValue} }
    'approvals.decide': { paramsTuple: [ParamValue]; params: {'id': ParamValue} }
    'approvals.cancel': { paramsTuple: [ParamValue]; params: {'id': ParamValue} }
    'approvals.delegations': { paramsTuple?: []; params?: {} }
    'approvals.create_delegation': { paramsTuple?: []; params?: {} }
    'approvals.revoke_delegation': { paramsTuple: [ParamValue]; params: {'id': ParamValue} }
    'attachments.index': { paramsTuple?: []; params?: {} }
    'attachments.store': { paramsTuple?: []; params?: {} }
    'attachments.download': { paramsTuple: [ParamValue]; params: {'id': ParamValue} }
    'attachments.destroy': { paramsTuple: [ParamValue]; params: {'id': ParamValue} }
    'platform.features': { paramsTuple?: []; params?: {} }
    'platform.plans': { paramsTuple?: []; params?: {} }
    'platform.create_plan': { paramsTuple?: []; params?: {} }
    'platform.plan': { paramsTuple: [ParamValue]; params: {'id': ParamValue} }
    'platform.update_plan': { paramsTuple: [ParamValue]; params: {'id': ParamValue} }
    'platform.publish_plan': { paramsTuple: [ParamValue]; params: {'id': ParamValue} }
    'platform.retire_plan': { paramsTuple: [ParamValue]; params: {'id': ParamValue} }
    'platform.tenants': { paramsTuple?: []; params?: {} }
    'platform.create_tenant': { paramsTuple?: []; params?: {} }
    'platform.tenant': { paramsTuple: [ParamValue]; params: {'id': ParamValue} }
    'platform.update_tenant': { paramsTuple: [ParamValue]; params: {'id': ParamValue} }
    'platform.subscription': { paramsTuple: [ParamValue]; params: {'id': ParamValue} }
    'platform.start_subscription': { paramsTuple: [ParamValue]; params: {'id': ParamValue} }
    'platform.set_override': { paramsTuple: [ParamValue,ParamValue]; params: {'id': ParamValue,'feature': ParamValue} }
    'platform.remove_override': { paramsTuple: [ParamValue,ParamValue]; params: {'id': ParamValue,'feature': ParamValue} }
    'platform.transition_subscription': { paramsTuple: [ParamValue]; params: {'id': ParamValue} }
  }
  GET: {
    'health.show': { paramsTuple?: []; params?: {} }
    'auth.me': { paramsTuple?: []; params?: {} }
    'account.sessions': { paramsTuple?: []; params?: {} }
    'roles.permissions': { paramsTuple?: []; params?: {} }
    'context.show': { paramsTuple?: []; params?: {} }
    'roles.mine': { paramsTuple?: []; params?: {} }
    'roles.index': { paramsTuple?: []; params?: {} }
    'roles.show': { paramsTuple: [ParamValue]; params: {'id': ParamValue} }
    'members.index': { paramsTuple?: []; params?: {} }
    'members.show': { paramsTuple: [ParamValue]; params: {'id': ParamValue} }
    'organization.index': { paramsTuple: [ParamValue]; params: {'kind': ParamValue} }
    'organization.tree': { paramsTuple: [ParamValue]; params: {'kind': ParamValue} }
    'organization.show': { paramsTuple: [ParamValue,ParamValue]; params: {'kind': ParamValue,'id': ParamValue} }
    'organization.dependents': { paramsTuple: [ParamValue,ParamValue]; params: {'kind': ParamValue,'id': ParamValue} }
    'tenant_subscription.show': { paramsTuple?: []; params?: {} }
    'settings.profile': { paramsTuple?: []; params?: {} }
    'settings.settings': { paramsTuple?: []; params?: {} }
    'exchange_rates.index': { paramsTuple?: []; params?: {} }
    'settings.lookup_rate': { paramsTuple?: []; params?: {} }
    'exchange_rates.show': { paramsTuple: [ParamValue]; params: {'id': ParamValue} }
    'document_series.index': { paramsTuple?: []; params?: {} }
    'document_series.show': { paramsTuple: [ParamValue]; params: {'id': ParamValue} }
    'settings.preview_series': { paramsTuple: [ParamValue]; params: {'id': ParamValue} }
    'calendars.index': { paramsTuple?: []; params?: {} }
    'calendars.show': { paramsTuple: [ParamValue]; params: {'id': ParamValue} }
    'settings.working_days': { paramsTuple: [ParamValue]; params: {'id': ParamValue} }
    'bank_accounts.index': { paramsTuple?: []; params?: {} }
    'bank_accounts.show': { paramsTuple: [ParamValue]; params: {'id': ParamValue} }
    'accounting.charts.index': { paramsTuple?: []; params?: {} }
    'accounting.charts.show': { paramsTuple: [ParamValue]; params: {'id': ParamValue} }
    'accounting.accounts.index': { paramsTuple?: []; params?: {} }
    'accounting.accounts.show': { paramsTuple: [ParamValue]; params: {'id': ParamValue} }
    'accounting.fiscal_years.index': { paramsTuple?: []; params?: {} }
    'accounting.fiscal_years.show': { paramsTuple: [ParamValue]; params: {'id': ParamValue} }
    'accounting.journals.index': { paramsTuple?: []; params?: {} }
    'accounting.journals.show': { paramsTuple: [ParamValue]; params: {'id': ParamValue} }
    'accounting.entries': { paramsTuple?: []; params?: {} }
    'accounting.entry': { paramsTuple: [ParamValue]; params: {'id': ParamValue} }
    'audit.index': { paramsTuple?: []; params?: {} }
    'notifications.index': { paramsTuple?: []; params?: {} }
    'tasks.index': { paramsTuple?: []; params?: {} }
    'dashboard.summary': { paramsTuple?: []; params?: {} }
    'dashboard.search': { paramsTuple?: []; params?: {} }
    'approvals.workflows': { paramsTuple?: []; params?: {} }
    'approvals.workflow': { paramsTuple: [ParamValue]; params: {'id': ParamValue} }
    'approvals.active_workflows': { paramsTuple?: []; params?: {} }
    'approvals.requests': { paramsTuple?: []; params?: {} }
    'approvals.request': { paramsTuple: [ParamValue]; params: {'id': ParamValue} }
    'approvals.delegations': { paramsTuple?: []; params?: {} }
    'attachments.index': { paramsTuple?: []; params?: {} }
    'attachments.download': { paramsTuple: [ParamValue]; params: {'id': ParamValue} }
    'platform.features': { paramsTuple?: []; params?: {} }
    'platform.plans': { paramsTuple?: []; params?: {} }
    'platform.plan': { paramsTuple: [ParamValue]; params: {'id': ParamValue} }
    'platform.tenants': { paramsTuple?: []; params?: {} }
    'platform.tenant': { paramsTuple: [ParamValue]; params: {'id': ParamValue} }
    'platform.subscription': { paramsTuple: [ParamValue]; params: {'id': ParamValue} }
  }
  HEAD: {
    'health.show': { paramsTuple?: []; params?: {} }
    'auth.me': { paramsTuple?: []; params?: {} }
    'account.sessions': { paramsTuple?: []; params?: {} }
    'roles.permissions': { paramsTuple?: []; params?: {} }
    'context.show': { paramsTuple?: []; params?: {} }
    'roles.mine': { paramsTuple?: []; params?: {} }
    'roles.index': { paramsTuple?: []; params?: {} }
    'roles.show': { paramsTuple: [ParamValue]; params: {'id': ParamValue} }
    'members.index': { paramsTuple?: []; params?: {} }
    'members.show': { paramsTuple: [ParamValue]; params: {'id': ParamValue} }
    'organization.index': { paramsTuple: [ParamValue]; params: {'kind': ParamValue} }
    'organization.tree': { paramsTuple: [ParamValue]; params: {'kind': ParamValue} }
    'organization.show': { paramsTuple: [ParamValue,ParamValue]; params: {'kind': ParamValue,'id': ParamValue} }
    'organization.dependents': { paramsTuple: [ParamValue,ParamValue]; params: {'kind': ParamValue,'id': ParamValue} }
    'tenant_subscription.show': { paramsTuple?: []; params?: {} }
    'settings.profile': { paramsTuple?: []; params?: {} }
    'settings.settings': { paramsTuple?: []; params?: {} }
    'exchange_rates.index': { paramsTuple?: []; params?: {} }
    'settings.lookup_rate': { paramsTuple?: []; params?: {} }
    'exchange_rates.show': { paramsTuple: [ParamValue]; params: {'id': ParamValue} }
    'document_series.index': { paramsTuple?: []; params?: {} }
    'document_series.show': { paramsTuple: [ParamValue]; params: {'id': ParamValue} }
    'settings.preview_series': { paramsTuple: [ParamValue]; params: {'id': ParamValue} }
    'calendars.index': { paramsTuple?: []; params?: {} }
    'calendars.show': { paramsTuple: [ParamValue]; params: {'id': ParamValue} }
    'settings.working_days': { paramsTuple: [ParamValue]; params: {'id': ParamValue} }
    'bank_accounts.index': { paramsTuple?: []; params?: {} }
    'bank_accounts.show': { paramsTuple: [ParamValue]; params: {'id': ParamValue} }
    'accounting.charts.index': { paramsTuple?: []; params?: {} }
    'accounting.charts.show': { paramsTuple: [ParamValue]; params: {'id': ParamValue} }
    'accounting.accounts.index': { paramsTuple?: []; params?: {} }
    'accounting.accounts.show': { paramsTuple: [ParamValue]; params: {'id': ParamValue} }
    'accounting.fiscal_years.index': { paramsTuple?: []; params?: {} }
    'accounting.fiscal_years.show': { paramsTuple: [ParamValue]; params: {'id': ParamValue} }
    'accounting.journals.index': { paramsTuple?: []; params?: {} }
    'accounting.journals.show': { paramsTuple: [ParamValue]; params: {'id': ParamValue} }
    'accounting.entries': { paramsTuple?: []; params?: {} }
    'accounting.entry': { paramsTuple: [ParamValue]; params: {'id': ParamValue} }
    'audit.index': { paramsTuple?: []; params?: {} }
    'notifications.index': { paramsTuple?: []; params?: {} }
    'tasks.index': { paramsTuple?: []; params?: {} }
    'dashboard.summary': { paramsTuple?: []; params?: {} }
    'dashboard.search': { paramsTuple?: []; params?: {} }
    'approvals.workflows': { paramsTuple?: []; params?: {} }
    'approvals.workflow': { paramsTuple: [ParamValue]; params: {'id': ParamValue} }
    'approvals.active_workflows': { paramsTuple?: []; params?: {} }
    'approvals.requests': { paramsTuple?: []; params?: {} }
    'approvals.request': { paramsTuple: [ParamValue]; params: {'id': ParamValue} }
    'approvals.delegations': { paramsTuple?: []; params?: {} }
    'attachments.index': { paramsTuple?: []; params?: {} }
    'attachments.download': { paramsTuple: [ParamValue]; params: {'id': ParamValue} }
    'platform.features': { paramsTuple?: []; params?: {} }
    'platform.plans': { paramsTuple?: []; params?: {} }
    'platform.plan': { paramsTuple: [ParamValue]; params: {'id': ParamValue} }
    'platform.tenants': { paramsTuple?: []; params?: {} }
    'platform.tenant': { paramsTuple: [ParamValue]; params: {'id': ParamValue} }
    'platform.subscription': { paramsTuple: [ParamValue]; params: {'id': ParamValue} }
  }
  POST: {
    'auth.login': { paramsTuple?: []; params?: {} }
    'account.forgot_password': { paramsTuple?: []; params?: {} }
    'account.reset_password': { paramsTuple?: []; params?: {} }
    'invitation.accept': { paramsTuple?: []; params?: {} }
    'auth.logout': { paramsTuple?: []; params?: {} }
    'roles.store': { paramsTuple?: []; params?: {} }
    'members.invite': { paramsTuple?: []; params?: {} }
    'members.resend_invitation': { paramsTuple: [ParamValue]; params: {'id': ParamValue} }
    'members.suspend': { paramsTuple: [ParamValue]; params: {'id': ParamValue} }
    'members.reactivate': { paramsTuple: [ParamValue]; params: {'id': ParamValue} }
    'members.assign_role': { paramsTuple: [ParamValue]; params: {'id': ParamValue} }
    'organization.store': { paramsTuple: [ParamValue]; params: {'kind': ParamValue} }
    'exchange_rates.store': { paramsTuple?: []; params?: {} }
    'document_series.store': { paramsTuple?: []; params?: {} }
    'calendars.store': { paramsTuple?: []; params?: {} }
    'settings.add_holiday': { paramsTuple: [ParamValue]; params: {'id': ParamValue} }
    'bank_accounts.store': { paramsTuple?: []; params?: {} }
    'accounting.charts.store': { paramsTuple?: []; params?: {} }
    'accounting.accounts.store': { paramsTuple?: []; params?: {} }
    'accounting.fiscal_years.store': { paramsTuple?: []; params?: {} }
    'accounting.journals.store': { paramsTuple?: []; params?: {} }
    'accounting.close_period': { paramsTuple: [ParamValue]; params: {'id': ParamValue} }
    'accounting.reopen_period': { paramsTuple: [ParamValue]; params: {'id': ParamValue} }
    'accounting.create_entry': { paramsTuple?: []; params?: {} }
    'accounting.submit': { paramsTuple: [ParamValue]; params: {'id': ParamValue} }
    'accounting.approve': { paramsTuple: [ParamValue]; params: {'id': ParamValue} }
    'accounting.reject': { paramsTuple: [ParamValue]; params: {'id': ParamValue} }
    'accounting.post': { paramsTuple: [ParamValue]; params: {'id': ParamValue} }
    'accounting.reverse': { paramsTuple: [ParamValue]; params: {'id': ParamValue} }
    'notifications.read_all': { paramsTuple?: []; params?: {} }
    'notifications.read': { paramsTuple: [ParamValue]; params: {'id': ParamValue} }
    'approvals.create_workflow': { paramsTuple?: []; params?: {} }
    'approvals.publish_workflow': { paramsTuple: [ParamValue]; params: {'id': ParamValue} }
    'approvals.retire_workflow': { paramsTuple: [ParamValue]; params: {'id': ParamValue} }
    'approvals.submit': { paramsTuple?: []; params?: {} }
    'approvals.decide': { paramsTuple: [ParamValue]; params: {'id': ParamValue} }
    'approvals.cancel': { paramsTuple: [ParamValue]; params: {'id': ParamValue} }
    'approvals.create_delegation': { paramsTuple?: []; params?: {} }
    'approvals.revoke_delegation': { paramsTuple: [ParamValue]; params: {'id': ParamValue} }
    'attachments.store': { paramsTuple?: []; params?: {} }
    'platform.create_plan': { paramsTuple?: []; params?: {} }
    'platform.publish_plan': { paramsTuple: [ParamValue]; params: {'id': ParamValue} }
    'platform.retire_plan': { paramsTuple: [ParamValue]; params: {'id': ParamValue} }
    'platform.create_tenant': { paramsTuple?: []; params?: {} }
    'platform.start_subscription': { paramsTuple: [ParamValue]; params: {'id': ParamValue} }
    'platform.transition_subscription': { paramsTuple: [ParamValue]; params: {'id': ParamValue} }
  }
  DELETE: {
    'account.revoke_session': { paramsTuple: [ParamValue]; params: {'id': ParamValue} }
    'roles.destroy': { paramsTuple: [ParamValue]; params: {'id': ParamValue} }
    'members.revoke_invitation': { paramsTuple: [ParamValue]; params: {'id': ParamValue} }
    'members.unassign_role': { paramsTuple: [ParamValue,ParamValue]; params: {'id': ParamValue,'assignmentId': ParamValue} }
    'settings.remove_holiday': { paramsTuple: [ParamValue,ParamValue]; params: {'id': ParamValue,'holidayId': ParamValue} }
    'accounting.delete_entry': { paramsTuple: [ParamValue]; params: {'id': ParamValue} }
    'approvals.delete_workflow': { paramsTuple: [ParamValue]; params: {'id': ParamValue} }
    'attachments.destroy': { paramsTuple: [ParamValue]; params: {'id': ParamValue} }
    'platform.remove_override': { paramsTuple: [ParamValue,ParamValue]; params: {'id': ParamValue,'feature': ParamValue} }
  }
  PATCH: {
    'roles.update': { paramsTuple: [ParamValue]; params: {'id': ParamValue} }
    'organization.update': { paramsTuple: [ParamValue,ParamValue]; params: {'kind': ParamValue,'id': ParamValue} }
    'exchange_rates.update': { paramsTuple: [ParamValue]; params: {'id': ParamValue} }
    'document_series.update': { paramsTuple: [ParamValue]; params: {'id': ParamValue} }
    'calendars.update': { paramsTuple: [ParamValue]; params: {'id': ParamValue} }
    'bank_accounts.update': { paramsTuple: [ParamValue]; params: {'id': ParamValue} }
    'accounting.charts.update': { paramsTuple: [ParamValue]; params: {'id': ParamValue} }
    'accounting.accounts.update': { paramsTuple: [ParamValue]; params: {'id': ParamValue} }
    'accounting.fiscal_years.update': { paramsTuple: [ParamValue]; params: {'id': ParamValue} }
    'accounting.journals.update': { paramsTuple: [ParamValue]; params: {'id': ParamValue} }
    'accounting.update_entry': { paramsTuple: [ParamValue]; params: {'id': ParamValue} }
    'approvals.update_workflow': { paramsTuple: [ParamValue]; params: {'id': ParamValue} }
    'platform.update_plan': { paramsTuple: [ParamValue]; params: {'id': ParamValue} }
    'platform.update_tenant': { paramsTuple: [ParamValue]; params: {'id': ParamValue} }
  }
  PUT: {
    'settings.update_profile': { paramsTuple?: []; params?: {} }
    'settings.update_settings': { paramsTuple?: []; params?: {} }
    'platform.set_override': { paramsTuple: [ParamValue,ParamValue]; params: {'id': ParamValue,'feature': ParamValue} }
  }
}
declare module '@adonisjs/core/types/http' {
  export interface RoutesList extends ScannedRoutes {}
}