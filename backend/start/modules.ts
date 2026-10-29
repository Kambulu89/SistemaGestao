/*
|--------------------------------------------------------------------------
| Módulos de negócio
|--------------------------------------------------------------------------
|
| Liga os módulos de negócio entre si por ganchos públicos, sem dependências inversas: o inventário reserva stock nas
| encomendas e protege a identidade de stock dos produtos no catálogo; as finanças verificam e reservam crédito nas encomendas e criam recebíveis ao emitir facturas; a prospecção liga-se ao serviço de notificações (regras de pedido, consentimento e ligações a recursos).
*/

import { registerDocumentResources } from '#modules/documents/index'
import { registerFinance } from '#modules/finance/index'
import { registerInventory } from '#modules/inventory/index'
import { registerProspecting } from '#modules/prospecting/index'

registerInventory()
registerFinance()
registerProspecting()
registerDocumentResources()
