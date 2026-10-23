/** API pública dos workflows de aprovação (C14). Outros módulos importam **apenas** daqui. */
import { registerRecordWorkflows } from '#dynamic/metadata/index'
import { workflowServices } from '#dynamic/workflows/presentation/composition'

export { workflowServices }

/** Liga os workflows às escritas dos registos (chamado no arranque, em `start/dynamic.ts`). */
export function registerDynamicWorkflows(): void {
  registerRecordWorkflows({
    onChanged: (scope, recordId) => workflowServices().instances.onRecordChanged(scope, recordId),
  })
}
