import {
  registerAutomationAction,
  registerAutomationEvent,
  textParamIssues,
} from '#dynamic/automations/index'
import { workflowServices } from '#dynamic/workflows/presentation/composition'

const INSTANCE_FIELDS = [
  { name: 'instanceId', kind: 'text' },
  { name: 'workflowCode', kind: 'text' },
  { name: 'workflowRevision', kind: 'number' },
  { name: 'entityCode', kind: 'text' },
  { name: 'recordId', kind: 'text' },
  { name: 'resourceVersion', kind: 'number' },
  { name: 'status', kind: 'text' },
  { name: 'endReason', kind: 'text' },
  { name: 'submittedByMembershipId', kind: 'text' },
] as const

const EVENTS: Record<string, string> = {
  approved: 'Um processo de aprovação foi aprovado',
  rejected: 'Um processo de aprovação foi rejeitado',
  returned: 'Um processo de aprovação foi devolvido',
  cancelled: 'Um processo de aprovação foi cancelado',
  failed: 'Um processo de aprovação falhou',
}

/** O que os workflows oferecem às automações (C15): os eventos de conclusão e a submissão a aprovação. */
export function registerWorkflowAutomations(): void {
  for (const [name, label] of Object.entries(EVENTS)) {
    registerAutomationEvent({
      type: `workflow.instance.${name}`,
      label,
      fields: [...INSTANCE_FIELDS],
    })
  }

  registerAutomationAction({
    type: 'workflow.submit',
    label: 'Submeter um registo a um workflow de aprovação',
    description:
      'Submete o registo ao workflow publicado, como o membro da automação (precisa de poder ler o registo e submeter).',
    params: [
      { name: 'entityCode', kind: 'text', required: true, description: 'Código da entidade.' },
      { name: 'recordId', kind: 'text', required: true, description: 'Identificador do registo.' },
      { name: 'workflowCode', kind: 'text', required: true, description: 'Código do workflow.' },
    ],
    validate: (params) => textParamIssues(params, ['entityCode', 'recordId', 'workflowCode']),
    async execute({ context, params }) {
      await workflowServices().instances.submit(context, {
        entityCode: String(params.entityCode),
        recordId: String(params.recordId),
        workflowCode: String(params.workflowCode),
      })
    },
  })
}
