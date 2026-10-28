/*
|--------------------------------------------------------------------------
| Módulos de negócio
|--------------------------------------------------------------------------
|
| Liga os módulos de negócio entre si por ganchos públicos, sem dependências inversas: o inventário reserva stock nas
| encomendas e protege a identidade de stock dos produtos no catálogo.
*/

import { registerInventory } from '#modules/inventory/index'

registerInventory()
