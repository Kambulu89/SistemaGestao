/** API pública dos terceiros (business partners): usada pelos papéis de fornecedor e cliente. */
export {
  addContact,
  createPartner,
  PARTNER_SPEC,
  partnerByTaxId,
  partnerView,
  updateContact,
  updatePartner,
  validatePartner,
  type PartnerView,
} from '#modules/partners/application/partner_service'
export { PARTNER_TYPES, type PartnerType } from '#modules/partners/domain/partners'
