import {
  registerAutomationAction,
  registerAutomationEvent,
  textParamIssues,
} from '#dynamic/automations/index'
import { stateServices } from '#dynamic/states/presentation/composition'

/** O que as máquinas de estados oferecem às automações (C15): um evento e uma acção. */
export function registerStateAutomations(): void {
  registerAutomationEvent({
    type: 'dynamic.record.state_changed',
    label: 'Um registo mudou de estado',
    fields: [
      { name: 'entityCode', kind: 'text' },
      { name: 'recordId', kind: 'text' },
      { name: 'machineCode', kind: 'text' },
      { name: 'machineRevision', kind: 'number' },
      { name: 'transition', kind: 'text' },
      { name: 'fromState', kind: 'text' },
      { name: 'toState', kind: 'text' },
      { name: 'actorMembershipId', kind: 'text' },
    ],
  })

  registerAutomationAction({
    type: 'dynamic.record.transition',
    label: 'Executar uma transição de estado num registo',
    description:
      'Executa a transição indicada como o membro da automação: só se ele a pode executar agora (permissões, guarda e estado actual).',
    params: [
      { name: 'entityCode', kind: 'text', required: true, description: 'Código da entidade.' },
      { name: 'recordId', kind: 'text', required: true, description: 'Identificador do registo.' },
      { name: 'transition', kind: 'text', required: true, description: 'Código da transição.' },
      {
        name: 'reason',
        kind: 'text',
        required: false,
        description: 'Motivo registado no histórico.',
      },
    ],
    validate: (params) =>
      textParamIssues(params, ['entityCode', 'recordId', 'transition'], ['reason']),
    async execute({ context, params }) {
      const entityCode = String(params.entityCode)
      const recordId = String(params.recordId)
      const transitions = stateServices().transitions
      const available = await transitions.availableActions(context, entityCode, recordId)
      await transitions.execute(context, entityCode, recordId, String(params.transition), {
        expectedVersion: available.state.version,
        reason: params.reason === undefined ? null : String(params.reason),
      })
    },
  })
}
