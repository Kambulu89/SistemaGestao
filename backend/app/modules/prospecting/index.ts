/** API pública do Prospecção e CRM comercial (M02). Outros módulos importam **apenas** daqui. */
export { prospectingServices } from '#modules/prospecting/presentation/composition'
export type { Campaign, Lead, Opportunity } from '#modules/prospecting/application/ports'
