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
    'accounting.rules': { paramsTuple?: []; params?: {} }
    'accounting.rule': { paramsTuple: [ParamValue]; params: {'id': ParamValue} }
    'accounting.events': { paramsTuple?: []; params?: {} }
    'accounting.event': { paramsTuple: [ParamValue]; params: {'id': ParamValue} }
    'accounting.simulate': { paramsTuple?: []; params?: {} }
    'accounting.charts.store': { paramsTuple?: []; params?: {} }
    'accounting.charts.update': { paramsTuple: [ParamValue]; params: {'id': ParamValue} }
    'accounting.accounts.store': { paramsTuple?: []; params?: {} }
    'accounting.accounts.update': { paramsTuple: [ParamValue]; params: {'id': ParamValue} }
    'accounting.fiscal_years.store': { paramsTuple?: []; params?: {} }
    'accounting.fiscal_years.update': { paramsTuple: [ParamValue]; params: {'id': ParamValue} }
    'accounting.journals.store': { paramsTuple?: []; params?: {} }
    'accounting.journals.update': { paramsTuple: [ParamValue]; params: {'id': ParamValue} }
    'accounting.create_rule': { paramsTuple?: []; params?: {} }
    'accounting.update_rule': { paramsTuple: [ParamValue]; params: {'id': ParamValue} }
    'accounting.dimensions': { paramsTuple?: []; params?: {} }
    'accounting.dimension': { paramsTuple: [ParamValue]; params: {'id': ParamValue} }
    'accounting.keys': { paramsTuple?: []; params?: {} }
    'accounting.key': { paramsTuple: [ParamValue]; params: {'id': ParamValue} }
    'accounting.allocations': { paramsTuple: [ParamValue]; params: {'id': ParamValue} }
    'accounting.create_dimension': { paramsTuple?: []; params?: {} }
    'accounting.update_dimension': { paramsTuple: [ParamValue]; params: {'id': ParamValue} }
    'accounting.create_value': { paramsTuple: [ParamValue]; params: {'id': ParamValue} }
    'accounting.update_value': { paramsTuple: [ParamValue,ParamValue]; params: {'id': ParamValue,'valueId': ParamValue} }
    'accounting.create_key': { paramsTuple?: []; params?: {} }
    'accounting.update_key': { paramsTuple: [ParamValue]; params: {'id': ParamValue} }
    'accounting.set_allocations': { paramsTuple: [ParamValue,ParamValue]; params: {'id': ParamValue,'lineNo': ParamValue} }
    'accounting.analytic_report': { paramsTuple?: []; params?: {} }
    'accounting.trial_balance': { paramsTuple?: []; params?: {} }
    'accounting.ledger': { paramsTuple?: []; params?: {} }
    'accounting.validate_opening': { paramsTuple?: []; params?: {} }
    'accounting.import_opening': { paramsTuple?: []; params?: {} }
    'accounting.submit_event': { paramsTuple?: []; params?: {} }
    'accounting.retry_event': { paramsTuple: [ParamValue]; params: {'id': ParamValue} }
    'closing.close_period': { paramsTuple: [ParamValue]; params: {'id': ParamValue} }
    'accounting.reopen_period': { paramsTuple: [ParamValue]; params: {'id': ParamValue} }
    'accounting.create_entry': { paramsTuple?: []; params?: {} }
    'accounting.update_entry': { paramsTuple: [ParamValue]; params: {'id': ParamValue} }
    'accounting.delete_entry': { paramsTuple: [ParamValue]; params: {'id': ParamValue} }
    'accounting.submit': { paramsTuple: [ParamValue]; params: {'id': ParamValue} }
    'accounting.approve': { paramsTuple: [ParamValue]; params: {'id': ParamValue} }
    'accounting.reject': { paramsTuple: [ParamValue]; params: {'id': ParamValue} }
    'accounting.post': { paramsTuple: [ParamValue]; params: {'id': ParamValue} }
    'accounting.reverse': { paramsTuple: [ParamValue]; params: {'id': ParamValue} }
    'closing.checklist': { paramsTuple: [ParamValue]; params: {'id': ParamValue} }
    'closing.year_status': { paramsTuple: [ParamValue]; params: {'id': ParamValue} }
    'closing.add_task': { paramsTuple: [ParamValue]; params: {'id': ParamValue} }
    'closing.copy_tasks': { paramsTuple: [ParamValue]; params: {'id': ParamValue} }
    'closing.update_task': { paramsTuple: [ParamValue]; params: {'id': ParamValue} }
    'closing.delete_task': { paramsTuple: [ParamValue]; params: {'id': ParamValue} }
    'closing.close_year': { paramsTuple: [ParamValue]; params: {'id': ParamValue} }
    'closing.reopen_year': { paramsTuple: [ParamValue]; params: {'id': ParamValue} }
    'statements.templates': { paramsTuple?: []; params?: {} }
    'statements.template': { paramsTuple: [ParamValue]; params: {'id': ParamValue} }
    'statements.create_template': { paramsTuple?: []; params?: {} }
    'statements.update_template': { paramsTuple: [ParamValue]; params: {'id': ParamValue} }
    'statements.delete_template': { paramsTuple: [ParamValue]; params: {'id': ParamValue} }
    'statements.publish_template': { paramsTuple: [ParamValue]; params: {'id': ParamValue} }
    'statements.new_version': { paramsTuple: [ParamValue]; params: {'id': ParamValue} }
    'statements.generate': { paramsTuple?: []; params?: {} }
    'statements.notes': { paramsTuple?: []; params?: {} }
    'statements.create_note': { paramsTuple?: []; params?: {} }
    'statements.update_note': { paramsTuple: [ParamValue]; params: {'id': ParamValue} }
    'statements.delete_note': { paramsTuple: [ParamValue]; params: {'id': ParamValue} }
    'adjustments.schedules': { paramsTuple?: []; params?: {} }
    'adjustments.schedule': { paramsTuple: [ParamValue]; params: {'id': ParamValue} }
    'adjustments.provisions': { paramsTuple?: []; params?: {} }
    'adjustments.provision': { paramsTuple: [ParamValue]; params: {'id': ParamValue} }
    'adjustments.revaluations': { paramsTuple?: []; params?: {} }
    'adjustments.reconciliations': { paramsTuple?: []; params?: {} }
    'adjustments.open_items': { paramsTuple?: []; params?: {} }
    'adjustments.create_schedule': { paramsTuple?: []; params?: {} }
    'adjustments.update_schedule': { paramsTuple: [ParamValue]; params: {'id': ParamValue} }
    'adjustments.preview_schedules': { paramsTuple?: []; params?: {} }
    'adjustments.generate_schedules': { paramsTuple?: []; params?: {} }
    'adjustments.create_provision': { paramsTuple?: []; params?: {} }
    'adjustments.update_provision': { paramsTuple: [ParamValue]; params: {'id': ParamValue} }
    'adjustments.move_provision': { paramsTuple: [ParamValue]; params: {'id': ParamValue} }
    'adjustments.preview_revaluation': { paramsTuple?: []; params?: {} }
    'adjustments.revalue': { paramsTuple?: []; params?: {} }
    'adjustments.reconcile': { paramsTuple?: []; params?: {} }
    'adjustments.undo_reconciliation': { paramsTuple: [ParamValue]; params: {'id': ParamValue} }
    'fixed_assets.classes': { paramsTuple?: []; params?: {} }
    'fixed_assets.show_class': { paramsTuple: [ParamValue]; params: {'id': ParamValue} }
    'fixed_assets.index': { paramsTuple?: []; params?: {} }
    'fixed_assets.preview': { paramsTuple?: []; params?: {} }
    'fixed_assets.map': { paramsTuple?: []; params?: {} }
    'fixed_assets.show': { paramsTuple: [ParamValue]; params: {'id': ParamValue} }
    'fixed_assets.create_class': { paramsTuple?: []; params?: {} }
    'fixed_assets.update_class': { paramsTuple: [ParamValue]; params: {'id': ParamValue} }
    'fixed_assets.store': { paramsTuple?: []; params?: {} }
    'fixed_assets.update': { paramsTuple: [ParamValue]; params: {'id': ParamValue} }
    'fixed_assets.destroy': { paramsTuple: [ParamValue]; params: {'id': ParamValue} }
    'fixed_assets.transfer': { paramsTuple: [ParamValue]; params: {'id': ParamValue} }
    'fixed_assets.acquire': { paramsTuple: [ParamValue]; params: {'id': ParamValue} }
    'fixed_assets.dispose': { paramsTuple: [ParamValue]; params: {'id': ParamValue} }
    'fixed_assets.reverse_acquisition': { paramsTuple: [ParamValue]; params: {'id': ParamValue} }
    'fixed_assets.reverse_disposal': { paramsTuple: [ParamValue]; params: {'id': ParamValue} }
    'fixed_assets.run': { paramsTuple?: []; params?: {} }
    'fixed_assets.undo': { paramsTuple?: []; params?: {} }
    'audit.index': { paramsTuple?: []; params?: {} }
    'notifications.index': { paramsTuple?: []; params?: {} }
    'notifications.read_all': { paramsTuple?: []; params?: {} }
    'notifications.read': { paramsTuple: [ParamValue]; params: {'id': ParamValue} }
    'tasks.index': { paramsTuple?: []; params?: {} }
    'preferences.show': { paramsTuple: [ParamValue]; params: {'key': ParamValue} }
    'preferences.update': { paramsTuple: [ParamValue]; params: {'key': ParamValue} }
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
    'employees.index': { paramsTuple?: []; params?: {} }
    'employees.store': { paramsTuple?: []; params?: {} }
    'employees.show': { paramsTuple: [ParamValue]; params: {'id': ParamValue} }
    'employees.update': { paramsTuple: [ParamValue]; params: {'id': ParamValue} }
    'employees.set_status': { paramsTuple: [ParamValue]; params: {'id': ParamValue} }
    'leave.types': { paramsTuple?: []; params?: {} }
    'leave.create_type': { paramsTuple?: []; params?: {} }
    'leave.update_type': { paramsTuple: [ParamValue]; params: {'id': ParamValue} }
    'leave.policies': { paramsTuple?: []; params?: {} }
    'leave.create_policy': { paramsTuple?: []; params?: {} }
    'leave.policy': { paramsTuple: [ParamValue]; params: {'id': ParamValue} }
    'leave.update_policy': { paramsTuple: [ParamValue]; params: {'id': ParamValue} }
    'leave.publish_policy': { paramsTuple: [ParamValue]; params: {'id': ParamValue} }
    'leave.accrue': { paramsTuple?: []; params?: {} }
    'leave.mine': { paramsTuple?: []; params?: {} }
    'leave.summary': { paramsTuple: [ParamValue]; params: {'id': ParamValue} }
    'leave.adjust': { paramsTuple: [ParamValue]; params: {'id': ParamValue} }
    'leave.requests': { paramsTuple?: []; params?: {} }
    'leave.create_request': { paramsTuple?: []; params?: {} }
    'leave.preview': { paramsTuple?: []; params?: {} }
    'leave.request': { paramsTuple: [ParamValue]; params: {'id': ParamValue} }
    'leave.decide': { paramsTuple: [ParamValue]; params: {'id': ParamValue} }
    'leave.cancel': { paramsTuple: [ParamValue]; params: {'id': ParamValue} }
    'compensation.components': { paramsTuple?: []; params?: {} }
    'compensation.create_component': { paramsTuple?: []; params?: {} }
    'compensation.component': { paramsTuple: [ParamValue]; params: {'id': ParamValue} }
    'compensation.update_component': { paramsTuple: [ParamValue]; params: {'id': ParamValue} }
    'compensation.add_incidence': { paramsTuple: [ParamValue]; params: {'id': ParamValue} }
    'compensation.summary': { paramsTuple: [ParamValue]; params: {'id': ParamValue} }
    'compensation.create_proposal': { paramsTuple: [ParamValue]; params: {'id': ParamValue} }
    'compensation.proposals': { paramsTuple?: []; params?: {} }
    'compensation.proposal': { paramsTuple: [ParamValue]; params: {'id': ParamValue} }
    'compensation.update_proposal': { paramsTuple: [ParamValue]; params: {'id': ParamValue} }
    'compensation.submit': { paramsTuple: [ParamValue]; params: {'id': ParamValue} }
    'compensation.decide': { paramsTuple: [ParamValue]; params: {'id': ParamValue} }
    'compensation.cancel': { paramsTuple: [ParamValue]; params: {'id': ParamValue} }
    'career.contracts': { paramsTuple: [ParamValue]; params: {'id': ParamValue} }
    'career.create_contract': { paramsTuple: [ParamValue]; params: {'id': ParamValue} }
    'career.assignments': { paramsTuple: [ParamValue]; params: {'id': ParamValue} }
    'career.move': { paramsTuple: [ParamValue]; params: {'id': ParamValue} }
    'career.contract': { paramsTuple: [ParamValue]; params: {'id': ParamValue} }
    'career.update_contract': { paramsTuple: [ParamValue]; params: {'id': ParamValue} }
    'career.activate': { paramsTuple: [ParamValue]; params: {'id': ParamValue} }
    'career.suspend': { paramsTuple: [ParamValue]; params: {'id': ParamValue} }
    'career.resume': { paramsTuple: [ParamValue]; params: {'id': ParamValue} }
    'career.terminate': { paramsTuple: [ParamValue]; params: {'id': ParamValue} }
    'career.cancel': { paramsTuple: [ParamValue]; params: {'id': ParamValue} }
    'career.amend': { paramsTuple: [ParamValue]; params: {'id': ParamValue} }
    'recruitment.onboarding': { paramsTuple: [ParamValue]; params: {'id': ParamValue} }
    'recruitment.create_onboarding_task': { paramsTuple: [ParamValue]; params: {'id': ParamValue} }
    'recruitment.update_onboarding_task': { paramsTuple: [ParamValue]; params: {'id': ParamValue} }
    'recruitment.settings': { paramsTuple?: []; params?: {} }
    'recruitment.update_settings': { paramsTuple?: []; params?: {} }
    'recruitment.requisitions': { paramsTuple?: []; params?: {} }
    'recruitment.create_requisition': { paramsTuple?: []; params?: {} }
    'recruitment.requisition': { paramsTuple: [ParamValue]; params: {'id': ParamValue} }
    'recruitment.update_requisition': { paramsTuple: [ParamValue]; params: {'id': ParamValue} }
    'recruitment.submit_requisition': { paramsTuple: [ParamValue]; params: {'id': ParamValue} }
    'recruitment.decide_requisition': { paramsTuple: [ParamValue]; params: {'id': ParamValue} }
    'recruitment.close_requisition': { paramsTuple: [ParamValue]; params: {'id': ParamValue} }
    'recruitment.cancel_requisition': { paramsTuple: [ParamValue]; params: {'id': ParamValue} }
    'recruitment.candidates': { paramsTuple?: []; params?: {} }
    'recruitment.create_candidate': { paramsTuple?: []; params?: {} }
    'recruitment.candidate': { paramsTuple: [ParamValue]; params: {'id': ParamValue} }
    'recruitment.update_candidate': { paramsTuple: [ParamValue]; params: {'id': ParamValue} }
    'recruitment.applications': { paramsTuple?: []; params?: {} }
    'recruitment.create_application': { paramsTuple?: []; params?: {} }
    'recruitment.application': { paramsTuple: [ParamValue]; params: {'id': ParamValue} }
    'recruitment.change_stage': { paramsTuple: [ParamValue]; params: {'id': ParamValue} }
    'recruitment.schedule_interview': { paramsTuple: [ParamValue]; params: {'id': ParamValue} }
    'recruitment.evaluate': { paramsTuple: [ParamValue]; params: {'id': ParamValue} }
    'recruitment.create_offer': { paramsTuple: [ParamValue]; params: {'id': ParamValue} }
    'recruitment.my_interviews': { paramsTuple?: []; params?: {} }
    'recruitment.update_interview': { paramsTuple: [ParamValue]; params: {'id': ParamValue} }
    'recruitment.update_offer': { paramsTuple: [ParamValue]; params: {'id': ParamValue} }
    'recruitment.submit_offer': { paramsTuple: [ParamValue]; params: {'id': ParamValue} }
    'recruitment.decide_offer': { paramsTuple: [ParamValue]; params: {'id': ParamValue} }
    'recruitment.respond_offer': { paramsTuple: [ParamValue]; params: {'id': ParamValue} }
    'recruitment.cancel_offer': { paramsTuple: [ParamValue]; params: {'id': ParamValue} }
    'recruitment.hire': { paramsTuple: [ParamValue]; params: {'id': ParamValue} }
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
    'accounting.rules': { paramsTuple?: []; params?: {} }
    'accounting.rule': { paramsTuple: [ParamValue]; params: {'id': ParamValue} }
    'accounting.events': { paramsTuple?: []; params?: {} }
    'accounting.event': { paramsTuple: [ParamValue]; params: {'id': ParamValue} }
    'accounting.dimensions': { paramsTuple?: []; params?: {} }
    'accounting.dimension': { paramsTuple: [ParamValue]; params: {'id': ParamValue} }
    'accounting.keys': { paramsTuple?: []; params?: {} }
    'accounting.key': { paramsTuple: [ParamValue]; params: {'id': ParamValue} }
    'accounting.allocations': { paramsTuple: [ParamValue]; params: {'id': ParamValue} }
    'accounting.analytic_report': { paramsTuple?: []; params?: {} }
    'accounting.trial_balance': { paramsTuple?: []; params?: {} }
    'accounting.ledger': { paramsTuple?: []; params?: {} }
    'closing.checklist': { paramsTuple: [ParamValue]; params: {'id': ParamValue} }
    'closing.year_status': { paramsTuple: [ParamValue]; params: {'id': ParamValue} }
    'statements.templates': { paramsTuple?: []; params?: {} }
    'statements.template': { paramsTuple: [ParamValue]; params: {'id': ParamValue} }
    'statements.generate': { paramsTuple?: []; params?: {} }
    'statements.notes': { paramsTuple?: []; params?: {} }
    'adjustments.schedules': { paramsTuple?: []; params?: {} }
    'adjustments.schedule': { paramsTuple: [ParamValue]; params: {'id': ParamValue} }
    'adjustments.provisions': { paramsTuple?: []; params?: {} }
    'adjustments.provision': { paramsTuple: [ParamValue]; params: {'id': ParamValue} }
    'adjustments.revaluations': { paramsTuple?: []; params?: {} }
    'adjustments.reconciliations': { paramsTuple?: []; params?: {} }
    'adjustments.open_items': { paramsTuple?: []; params?: {} }
    'adjustments.preview_schedules': { paramsTuple?: []; params?: {} }
    'adjustments.preview_revaluation': { paramsTuple?: []; params?: {} }
    'fixed_assets.classes': { paramsTuple?: []; params?: {} }
    'fixed_assets.show_class': { paramsTuple: [ParamValue]; params: {'id': ParamValue} }
    'fixed_assets.index': { paramsTuple?: []; params?: {} }
    'fixed_assets.preview': { paramsTuple?: []; params?: {} }
    'fixed_assets.map': { paramsTuple?: []; params?: {} }
    'fixed_assets.show': { paramsTuple: [ParamValue]; params: {'id': ParamValue} }
    'audit.index': { paramsTuple?: []; params?: {} }
    'notifications.index': { paramsTuple?: []; params?: {} }
    'tasks.index': { paramsTuple?: []; params?: {} }
    'preferences.show': { paramsTuple: [ParamValue]; params: {'key': ParamValue} }
    'dashboard.summary': { paramsTuple?: []; params?: {} }
    'dashboard.search': { paramsTuple?: []; params?: {} }
    'approvals.workflows': { paramsTuple?: []; params?: {} }
    'approvals.workflow': { paramsTuple: [ParamValue]; params: {'id': ParamValue} }
    'approvals.active_workflows': { paramsTuple?: []; params?: {} }
    'approvals.requests': { paramsTuple?: []; params?: {} }
    'approvals.request': { paramsTuple: [ParamValue]; params: {'id': ParamValue} }
    'approvals.delegations': { paramsTuple?: []; params?: {} }
    'employees.index': { paramsTuple?: []; params?: {} }
    'employees.show': { paramsTuple: [ParamValue]; params: {'id': ParamValue} }
    'leave.types': { paramsTuple?: []; params?: {} }
    'leave.policies': { paramsTuple?: []; params?: {} }
    'leave.policy': { paramsTuple: [ParamValue]; params: {'id': ParamValue} }
    'leave.mine': { paramsTuple?: []; params?: {} }
    'leave.summary': { paramsTuple: [ParamValue]; params: {'id': ParamValue} }
    'leave.requests': { paramsTuple?: []; params?: {} }
    'leave.request': { paramsTuple: [ParamValue]; params: {'id': ParamValue} }
    'compensation.components': { paramsTuple?: []; params?: {} }
    'compensation.component': { paramsTuple: [ParamValue]; params: {'id': ParamValue} }
    'compensation.summary': { paramsTuple: [ParamValue]; params: {'id': ParamValue} }
    'compensation.proposals': { paramsTuple?: []; params?: {} }
    'compensation.proposal': { paramsTuple: [ParamValue]; params: {'id': ParamValue} }
    'career.contracts': { paramsTuple: [ParamValue]; params: {'id': ParamValue} }
    'career.assignments': { paramsTuple: [ParamValue]; params: {'id': ParamValue} }
    'career.contract': { paramsTuple: [ParamValue]; params: {'id': ParamValue} }
    'recruitment.onboarding': { paramsTuple: [ParamValue]; params: {'id': ParamValue} }
    'recruitment.settings': { paramsTuple?: []; params?: {} }
    'recruitment.requisitions': { paramsTuple?: []; params?: {} }
    'recruitment.requisition': { paramsTuple: [ParamValue]; params: {'id': ParamValue} }
    'recruitment.candidates': { paramsTuple?: []; params?: {} }
    'recruitment.candidate': { paramsTuple: [ParamValue]; params: {'id': ParamValue} }
    'recruitment.applications': { paramsTuple?: []; params?: {} }
    'recruitment.application': { paramsTuple: [ParamValue]; params: {'id': ParamValue} }
    'recruitment.my_interviews': { paramsTuple?: []; params?: {} }
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
    'accounting.rules': { paramsTuple?: []; params?: {} }
    'accounting.rule': { paramsTuple: [ParamValue]; params: {'id': ParamValue} }
    'accounting.events': { paramsTuple?: []; params?: {} }
    'accounting.event': { paramsTuple: [ParamValue]; params: {'id': ParamValue} }
    'accounting.dimensions': { paramsTuple?: []; params?: {} }
    'accounting.dimension': { paramsTuple: [ParamValue]; params: {'id': ParamValue} }
    'accounting.keys': { paramsTuple?: []; params?: {} }
    'accounting.key': { paramsTuple: [ParamValue]; params: {'id': ParamValue} }
    'accounting.allocations': { paramsTuple: [ParamValue]; params: {'id': ParamValue} }
    'accounting.analytic_report': { paramsTuple?: []; params?: {} }
    'accounting.trial_balance': { paramsTuple?: []; params?: {} }
    'accounting.ledger': { paramsTuple?: []; params?: {} }
    'closing.checklist': { paramsTuple: [ParamValue]; params: {'id': ParamValue} }
    'closing.year_status': { paramsTuple: [ParamValue]; params: {'id': ParamValue} }
    'statements.templates': { paramsTuple?: []; params?: {} }
    'statements.template': { paramsTuple: [ParamValue]; params: {'id': ParamValue} }
    'statements.generate': { paramsTuple?: []; params?: {} }
    'statements.notes': { paramsTuple?: []; params?: {} }
    'adjustments.schedules': { paramsTuple?: []; params?: {} }
    'adjustments.schedule': { paramsTuple: [ParamValue]; params: {'id': ParamValue} }
    'adjustments.provisions': { paramsTuple?: []; params?: {} }
    'adjustments.provision': { paramsTuple: [ParamValue]; params: {'id': ParamValue} }
    'adjustments.revaluations': { paramsTuple?: []; params?: {} }
    'adjustments.reconciliations': { paramsTuple?: []; params?: {} }
    'adjustments.open_items': { paramsTuple?: []; params?: {} }
    'adjustments.preview_schedules': { paramsTuple?: []; params?: {} }
    'adjustments.preview_revaluation': { paramsTuple?: []; params?: {} }
    'fixed_assets.classes': { paramsTuple?: []; params?: {} }
    'fixed_assets.show_class': { paramsTuple: [ParamValue]; params: {'id': ParamValue} }
    'fixed_assets.index': { paramsTuple?: []; params?: {} }
    'fixed_assets.preview': { paramsTuple?: []; params?: {} }
    'fixed_assets.map': { paramsTuple?: []; params?: {} }
    'fixed_assets.show': { paramsTuple: [ParamValue]; params: {'id': ParamValue} }
    'audit.index': { paramsTuple?: []; params?: {} }
    'notifications.index': { paramsTuple?: []; params?: {} }
    'tasks.index': { paramsTuple?: []; params?: {} }
    'preferences.show': { paramsTuple: [ParamValue]; params: {'key': ParamValue} }
    'dashboard.summary': { paramsTuple?: []; params?: {} }
    'dashboard.search': { paramsTuple?: []; params?: {} }
    'approvals.workflows': { paramsTuple?: []; params?: {} }
    'approvals.workflow': { paramsTuple: [ParamValue]; params: {'id': ParamValue} }
    'approvals.active_workflows': { paramsTuple?: []; params?: {} }
    'approvals.requests': { paramsTuple?: []; params?: {} }
    'approvals.request': { paramsTuple: [ParamValue]; params: {'id': ParamValue} }
    'approvals.delegations': { paramsTuple?: []; params?: {} }
    'employees.index': { paramsTuple?: []; params?: {} }
    'employees.show': { paramsTuple: [ParamValue]; params: {'id': ParamValue} }
    'leave.types': { paramsTuple?: []; params?: {} }
    'leave.policies': { paramsTuple?: []; params?: {} }
    'leave.policy': { paramsTuple: [ParamValue]; params: {'id': ParamValue} }
    'leave.mine': { paramsTuple?: []; params?: {} }
    'leave.summary': { paramsTuple: [ParamValue]; params: {'id': ParamValue} }
    'leave.requests': { paramsTuple?: []; params?: {} }
    'leave.request': { paramsTuple: [ParamValue]; params: {'id': ParamValue} }
    'compensation.components': { paramsTuple?: []; params?: {} }
    'compensation.component': { paramsTuple: [ParamValue]; params: {'id': ParamValue} }
    'compensation.summary': { paramsTuple: [ParamValue]; params: {'id': ParamValue} }
    'compensation.proposals': { paramsTuple?: []; params?: {} }
    'compensation.proposal': { paramsTuple: [ParamValue]; params: {'id': ParamValue} }
    'career.contracts': { paramsTuple: [ParamValue]; params: {'id': ParamValue} }
    'career.assignments': { paramsTuple: [ParamValue]; params: {'id': ParamValue} }
    'career.contract': { paramsTuple: [ParamValue]; params: {'id': ParamValue} }
    'recruitment.onboarding': { paramsTuple: [ParamValue]; params: {'id': ParamValue} }
    'recruitment.settings': { paramsTuple?: []; params?: {} }
    'recruitment.requisitions': { paramsTuple?: []; params?: {} }
    'recruitment.requisition': { paramsTuple: [ParamValue]; params: {'id': ParamValue} }
    'recruitment.candidates': { paramsTuple?: []; params?: {} }
    'recruitment.candidate': { paramsTuple: [ParamValue]; params: {'id': ParamValue} }
    'recruitment.applications': { paramsTuple?: []; params?: {} }
    'recruitment.application': { paramsTuple: [ParamValue]; params: {'id': ParamValue} }
    'recruitment.my_interviews': { paramsTuple?: []; params?: {} }
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
    'accounting.simulate': { paramsTuple?: []; params?: {} }
    'accounting.charts.store': { paramsTuple?: []; params?: {} }
    'accounting.accounts.store': { paramsTuple?: []; params?: {} }
    'accounting.fiscal_years.store': { paramsTuple?: []; params?: {} }
    'accounting.journals.store': { paramsTuple?: []; params?: {} }
    'accounting.create_rule': { paramsTuple?: []; params?: {} }
    'accounting.create_dimension': { paramsTuple?: []; params?: {} }
    'accounting.create_value': { paramsTuple: [ParamValue]; params: {'id': ParamValue} }
    'accounting.create_key': { paramsTuple?: []; params?: {} }
    'accounting.validate_opening': { paramsTuple?: []; params?: {} }
    'accounting.import_opening': { paramsTuple?: []; params?: {} }
    'accounting.submit_event': { paramsTuple?: []; params?: {} }
    'accounting.retry_event': { paramsTuple: [ParamValue]; params: {'id': ParamValue} }
    'closing.close_period': { paramsTuple: [ParamValue]; params: {'id': ParamValue} }
    'accounting.reopen_period': { paramsTuple: [ParamValue]; params: {'id': ParamValue} }
    'accounting.create_entry': { paramsTuple?: []; params?: {} }
    'accounting.submit': { paramsTuple: [ParamValue]; params: {'id': ParamValue} }
    'accounting.approve': { paramsTuple: [ParamValue]; params: {'id': ParamValue} }
    'accounting.reject': { paramsTuple: [ParamValue]; params: {'id': ParamValue} }
    'accounting.post': { paramsTuple: [ParamValue]; params: {'id': ParamValue} }
    'accounting.reverse': { paramsTuple: [ParamValue]; params: {'id': ParamValue} }
    'closing.add_task': { paramsTuple: [ParamValue]; params: {'id': ParamValue} }
    'closing.copy_tasks': { paramsTuple: [ParamValue]; params: {'id': ParamValue} }
    'closing.close_year': { paramsTuple: [ParamValue]; params: {'id': ParamValue} }
    'closing.reopen_year': { paramsTuple: [ParamValue]; params: {'id': ParamValue} }
    'statements.create_template': { paramsTuple?: []; params?: {} }
    'statements.publish_template': { paramsTuple: [ParamValue]; params: {'id': ParamValue} }
    'statements.new_version': { paramsTuple: [ParamValue]; params: {'id': ParamValue} }
    'statements.create_note': { paramsTuple?: []; params?: {} }
    'adjustments.create_schedule': { paramsTuple?: []; params?: {} }
    'adjustments.generate_schedules': { paramsTuple?: []; params?: {} }
    'adjustments.create_provision': { paramsTuple?: []; params?: {} }
    'adjustments.move_provision': { paramsTuple: [ParamValue]; params: {'id': ParamValue} }
    'adjustments.revalue': { paramsTuple?: []; params?: {} }
    'adjustments.reconcile': { paramsTuple?: []; params?: {} }
    'fixed_assets.create_class': { paramsTuple?: []; params?: {} }
    'fixed_assets.store': { paramsTuple?: []; params?: {} }
    'fixed_assets.transfer': { paramsTuple: [ParamValue]; params: {'id': ParamValue} }
    'fixed_assets.acquire': { paramsTuple: [ParamValue]; params: {'id': ParamValue} }
    'fixed_assets.dispose': { paramsTuple: [ParamValue]; params: {'id': ParamValue} }
    'fixed_assets.reverse_acquisition': { paramsTuple: [ParamValue]; params: {'id': ParamValue} }
    'fixed_assets.reverse_disposal': { paramsTuple: [ParamValue]; params: {'id': ParamValue} }
    'fixed_assets.run': { paramsTuple?: []; params?: {} }
    'fixed_assets.undo': { paramsTuple?: []; params?: {} }
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
    'employees.store': { paramsTuple?: []; params?: {} }
    'employees.set_status': { paramsTuple: [ParamValue]; params: {'id': ParamValue} }
    'leave.create_type': { paramsTuple?: []; params?: {} }
    'leave.create_policy': { paramsTuple?: []; params?: {} }
    'leave.publish_policy': { paramsTuple: [ParamValue]; params: {'id': ParamValue} }
    'leave.accrue': { paramsTuple?: []; params?: {} }
    'leave.adjust': { paramsTuple: [ParamValue]; params: {'id': ParamValue} }
    'leave.create_request': { paramsTuple?: []; params?: {} }
    'leave.preview': { paramsTuple?: []; params?: {} }
    'leave.decide': { paramsTuple: [ParamValue]; params: {'id': ParamValue} }
    'leave.cancel': { paramsTuple: [ParamValue]; params: {'id': ParamValue} }
    'compensation.create_component': { paramsTuple?: []; params?: {} }
    'compensation.add_incidence': { paramsTuple: [ParamValue]; params: {'id': ParamValue} }
    'compensation.create_proposal': { paramsTuple: [ParamValue]; params: {'id': ParamValue} }
    'compensation.submit': { paramsTuple: [ParamValue]; params: {'id': ParamValue} }
    'compensation.decide': { paramsTuple: [ParamValue]; params: {'id': ParamValue} }
    'compensation.cancel': { paramsTuple: [ParamValue]; params: {'id': ParamValue} }
    'career.create_contract': { paramsTuple: [ParamValue]; params: {'id': ParamValue} }
    'career.move': { paramsTuple: [ParamValue]; params: {'id': ParamValue} }
    'career.activate': { paramsTuple: [ParamValue]; params: {'id': ParamValue} }
    'career.suspend': { paramsTuple: [ParamValue]; params: {'id': ParamValue} }
    'career.resume': { paramsTuple: [ParamValue]; params: {'id': ParamValue} }
    'career.terminate': { paramsTuple: [ParamValue]; params: {'id': ParamValue} }
    'career.cancel': { paramsTuple: [ParamValue]; params: {'id': ParamValue} }
    'career.amend': { paramsTuple: [ParamValue]; params: {'id': ParamValue} }
    'recruitment.create_onboarding_task': { paramsTuple: [ParamValue]; params: {'id': ParamValue} }
    'recruitment.create_requisition': { paramsTuple?: []; params?: {} }
    'recruitment.submit_requisition': { paramsTuple: [ParamValue]; params: {'id': ParamValue} }
    'recruitment.decide_requisition': { paramsTuple: [ParamValue]; params: {'id': ParamValue} }
    'recruitment.close_requisition': { paramsTuple: [ParamValue]; params: {'id': ParamValue} }
    'recruitment.cancel_requisition': { paramsTuple: [ParamValue]; params: {'id': ParamValue} }
    'recruitment.create_candidate': { paramsTuple?: []; params?: {} }
    'recruitment.create_application': { paramsTuple?: []; params?: {} }
    'recruitment.change_stage': { paramsTuple: [ParamValue]; params: {'id': ParamValue} }
    'recruitment.schedule_interview': { paramsTuple: [ParamValue]; params: {'id': ParamValue} }
    'recruitment.evaluate': { paramsTuple: [ParamValue]; params: {'id': ParamValue} }
    'recruitment.create_offer': { paramsTuple: [ParamValue]; params: {'id': ParamValue} }
    'recruitment.submit_offer': { paramsTuple: [ParamValue]; params: {'id': ParamValue} }
    'recruitment.decide_offer': { paramsTuple: [ParamValue]; params: {'id': ParamValue} }
    'recruitment.respond_offer': { paramsTuple: [ParamValue]; params: {'id': ParamValue} }
    'recruitment.cancel_offer': { paramsTuple: [ParamValue]; params: {'id': ParamValue} }
    'recruitment.hire': { paramsTuple: [ParamValue]; params: {'id': ParamValue} }
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
    'closing.delete_task': { paramsTuple: [ParamValue]; params: {'id': ParamValue} }
    'statements.delete_template': { paramsTuple: [ParamValue]; params: {'id': ParamValue} }
    'statements.delete_note': { paramsTuple: [ParamValue]; params: {'id': ParamValue} }
    'adjustments.undo_reconciliation': { paramsTuple: [ParamValue]; params: {'id': ParamValue} }
    'fixed_assets.destroy': { paramsTuple: [ParamValue]; params: {'id': ParamValue} }
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
    'accounting.update_rule': { paramsTuple: [ParamValue]; params: {'id': ParamValue} }
    'accounting.update_dimension': { paramsTuple: [ParamValue]; params: {'id': ParamValue} }
    'accounting.update_value': { paramsTuple: [ParamValue,ParamValue]; params: {'id': ParamValue,'valueId': ParamValue} }
    'accounting.update_key': { paramsTuple: [ParamValue]; params: {'id': ParamValue} }
    'accounting.update_entry': { paramsTuple: [ParamValue]; params: {'id': ParamValue} }
    'closing.update_task': { paramsTuple: [ParamValue]; params: {'id': ParamValue} }
    'statements.update_template': { paramsTuple: [ParamValue]; params: {'id': ParamValue} }
    'statements.update_note': { paramsTuple: [ParamValue]; params: {'id': ParamValue} }
    'adjustments.update_schedule': { paramsTuple: [ParamValue]; params: {'id': ParamValue} }
    'adjustments.update_provision': { paramsTuple: [ParamValue]; params: {'id': ParamValue} }
    'fixed_assets.update_class': { paramsTuple: [ParamValue]; params: {'id': ParamValue} }
    'fixed_assets.update': { paramsTuple: [ParamValue]; params: {'id': ParamValue} }
    'approvals.update_workflow': { paramsTuple: [ParamValue]; params: {'id': ParamValue} }
    'employees.update': { paramsTuple: [ParamValue]; params: {'id': ParamValue} }
    'leave.update_type': { paramsTuple: [ParamValue]; params: {'id': ParamValue} }
    'leave.update_policy': { paramsTuple: [ParamValue]; params: {'id': ParamValue} }
    'compensation.update_component': { paramsTuple: [ParamValue]; params: {'id': ParamValue} }
    'compensation.update_proposal': { paramsTuple: [ParamValue]; params: {'id': ParamValue} }
    'career.update_contract': { paramsTuple: [ParamValue]; params: {'id': ParamValue} }
    'recruitment.update_onboarding_task': { paramsTuple: [ParamValue]; params: {'id': ParamValue} }
    'recruitment.update_requisition': { paramsTuple: [ParamValue]; params: {'id': ParamValue} }
    'recruitment.update_candidate': { paramsTuple: [ParamValue]; params: {'id': ParamValue} }
    'recruitment.update_interview': { paramsTuple: [ParamValue]; params: {'id': ParamValue} }
    'recruitment.update_offer': { paramsTuple: [ParamValue]; params: {'id': ParamValue} }
    'platform.update_plan': { paramsTuple: [ParamValue]; params: {'id': ParamValue} }
    'platform.update_tenant': { paramsTuple: [ParamValue]; params: {'id': ParamValue} }
  }
  PUT: {
    'settings.update_profile': { paramsTuple?: []; params?: {} }
    'settings.update_settings': { paramsTuple?: []; params?: {} }
    'accounting.set_allocations': { paramsTuple: [ParamValue,ParamValue]; params: {'id': ParamValue,'lineNo': ParamValue} }
    'preferences.update': { paramsTuple: [ParamValue]; params: {'key': ParamValue} }
    'recruitment.update_settings': { paramsTuple?: []; params?: {} }
    'platform.set_override': { paramsTuple: [ParamValue,ParamValue]; params: {'id': ParamValue,'feature': ParamValue} }
  }
}
declare module '@adonisjs/core/types/http' {
  export interface RoutesList extends ScannedRoutes {}
}