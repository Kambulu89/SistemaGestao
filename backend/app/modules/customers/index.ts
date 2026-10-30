/** API pública dos clientes (M01). Outros módulos (propostas, encomendas, faturação) importam **apenas** daqui. */
export { customerServices } from '#modules/customers/presentation/composition'
export type { Customer, Interaction, Segment } from '#modules/customers/application/ports'
export type { CustomerStatus } from '#modules/customers/domain/customers'
