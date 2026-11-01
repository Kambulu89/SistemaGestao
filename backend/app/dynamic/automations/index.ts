/** API pública das automações (C15). Outros módulos importam **apenas** daqui. */
export { automationServices } from '#dynamic/automations/presentation/composition'
export {
  registerAutomationAction,
  registerAutomationEvent,
} from '#dynamic/automations/application/registry'
export type {
  ActionExecution,
  ActionHandler,
  EventDescriptor,
} from '#dynamic/automations/application/ports'
export { textParamIssues } from '#dynamic/automations/domain/automation'
