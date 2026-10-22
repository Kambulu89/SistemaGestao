/** API pública do módulo de autorização (C06). Outros módulos importam **apenas** daqui. */
export {
  PERMISSION_CATALOG,
  TENANT_ADMIN_ROLE,
  type PermissionDefinition,
} from '#core/permissions/domain/catalog'
export {
  decide,
  forbiddenChanges,
  redactFields,
  type AccessPolicy,
  type Decision,
  type FieldRule,
  type Grant,
  type UnitScope,
} from '#core/permissions/domain/decision'
export {
  evaluateCondition,
  validateCondition,
  type Condition,
  type EvalContext,
} from '#core/permissions/domain/condition'
export { iamServices } from '#core/permissions/presentation/composition'
