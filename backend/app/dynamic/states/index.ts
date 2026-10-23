/** API pública das máquinas de estados (C13). Outros módulos importam **apenas** daqui. */
import { registerRecordStates } from '#dynamic/metadata/index'
import { stateServices } from '#dynamic/states/presentation/composition'

export { stateServices }

/** Liga as máquinas de estados aos registos (chamado no arranque, em `start/dynamic.ts`). */
export function registerDynamicStates(): void {
  registerRecordStates(stateServices().hook)
}
