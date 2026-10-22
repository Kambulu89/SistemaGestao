import vine from '@vinejs/vine'

const fieldRule = vine.object({
  field: vine.string().maxLength(60),
  mode: vine.enum(['HIDDEN', 'READ_ONLY'] as const),
  when: vine.any().optional(),
})

export const createRoleValidator = vine.compile(
  vine.object({
    code: vine.string().trim().maxLength(60),
    name: vine.string().trim().maxLength(120),
    description: vine.string().trim().maxLength(300).nullable().optional(),
    permissionCodes: vine.array(vine.string().maxLength(100)).maxLength(200),
  })
)

export const updateRoleValidator = vine.compile(
  vine.object({
    expectedVersion: vine.number().withoutDecimals().min(1),
    name: vine.string().trim().maxLength(120).optional(),
    description: vine.string().trim().maxLength(300).nullable().optional(),
    permissionCodes: vine.array(vine.string().maxLength(100)).maxLength(200).optional(),
  })
)

export const assignRoleValidator = vine.compile(
  vine.object({
    membershipId: vine.string().uuid(),
    roleId: vine.string().uuid(),
    organizationUnitId: vine.string().uuid().nullable().optional(),
    validFrom: vine
      .date({ formats: ['iso8601'] })
      .nullable()
      .optional(),
    validUntil: vine
      .date({ formats: ['iso8601'] })
      .nullable()
      .optional(),
  })
)

export const listAssignmentsValidator = vine.compile(
  vine.object({ membershipId: vine.string().uuid().optional() })
)

const policyFields = {
  name: vine.string().trim().maxLength(120),
  resource: vine.string().trim().maxLength(60),
  action: vine.string().trim().maxLength(40),
  effect: vine.enum(['ALLOW', 'DENY'] as const),
  condition: vine.any().optional(),
  priority: vine.number().withoutDecimals().optional(),
  status: vine.enum(['DRAFT', 'ACTIVE', 'DISABLED'] as const).optional(),
  fieldRules: vine.array(fieldRule).maxLength(50).optional(),
}

export const createPolicyValidator = vine.compile(vine.object(policyFields))

export const updatePolicyValidator = vine.compile(
  vine.object({
    expectedVersion: vine.number().withoutDecimals().min(1),
    name: policyFields.name.optional(),
    resource: policyFields.resource.optional(),
    action: policyFields.action.optional(),
    effect: policyFields.effect.optional(),
    condition: vine.any().optional(),
    priority: policyFields.priority,
    status: policyFields.status,
    fieldRules: policyFields.fieldRules,
  })
)

export const simulateValidator = vine.compile(
  vine.object({
    membershipId: vine.string().uuid(),
    permission: vine.string().maxLength(100),
    resource: vine.record(vine.any()).optional(),
  })
)
