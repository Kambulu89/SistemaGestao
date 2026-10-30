/** API pública da prospecção e CRM (M02). Outros módulos importam **apenas** daqui. */
export { prospectingServices } from '#modules/prospecting/presentation/composition'
export { registerProspecting } from '#modules/prospecting/presentation/registration'
export type { Campaign, Lead, Opportunity } from '#modules/prospecting/application/ports'
