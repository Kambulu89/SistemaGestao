import type {
  ActionHandler,
  AutomationCatalog,
  EventDescriptor,
} from '#dynamic/automations/application/ports'

const actions = new Map<string, ActionHandler>()
const events = new Map<string, EventDescriptor>()

/** Os módulos registam aqui as acções que as automações podem executar (no arranque, em `start/dynamic.ts`). */
export function registerAutomationAction(handler: ActionHandler): void {
  actions.set(handler.type, handler)
}

/** Os módulos registam aqui os eventos do outbox que as automações podem usar como gatilho. */
export function registerAutomationEvent(descriptor: EventDescriptor): void {
  events.set(descriptor.type, descriptor)
}

export const findAction = (type: string): ActionHandler | undefined => actions.get(type)
export const findEvent = (type: string): EventDescriptor | undefined => events.get(type)

export function currentCatalog(): AutomationCatalog {
  return {
    events: [...events.values()].sort((a, b) => a.type.localeCompare(b.type)),
    actions: [...actions.values()]
      .map(({ type, label, description, params }) => ({ type, label, description, params }))
      .sort((a, b) => a.type.localeCompare(b.type)),
  }
}
