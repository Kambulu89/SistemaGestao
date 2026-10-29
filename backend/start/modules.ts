/*
|--------------------------------------------------------------------------
| Módulos de negócio
|--------------------------------------------------------------------------
|
| Liga os módulos de negócio entre si por ganchos públicos, sem dependências inversas: o inventário reserva stock nas
| encomendas e protege a identidade de stock dos produtos no catálogo; as finanças verificam e reservam crédito nas encomendas e criam recebíveis ao emitir facturas.
*/

import { registerFinance } from '#modules/finance/index'
import { registerInventory } from '#modules/inventory/index'

registerInventory()
registerFinance()
