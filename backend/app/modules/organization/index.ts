/** API pública da estrutura organizacional. */
export {
  ENTITY_TYPES as ORGANIZATION_ENTITY_TYPES,
  OrganizationService,
  organizationRecordExists,
} from '#modules/organization/application/organization_service'
export type { OrgKind } from '#modules/organization/domain/organization'
