import { iamServices } from '#core/permissions/index'
import { serviceTenantContext } from '#core/tenancy/index'
import type { Tenant } from '#platform/tenants/index'
import { api, newActor, type Actor } from '#tests/support/api_fixture'
import { license, syncTestRegistry } from '#tests/support/modules_fixture'
import { addMember, createActiveTenant } from '#tests/support/membership_fixture'
import { createActiveUser } from '#tests/support/auth_fixture'

export type Http = ReturnType<typeof api>

export interface World {
  label: string
  tenant: Tenant
  /** Administrador (`tenant_admin`). */
  admin: Actor
  /** Membro activo sem nenhum papel: nega por omissão. */
  operator: Actor
  /** Membro com um papel limitado (party.read) e âmbito de acesso à organização. */
  member: Actor
  http: Http
  ids: {
    role: string
    assignment: string
    policy: string
    organization: string
    unitRoot: string
    unitChild: string
    costCenter: string
    teamMember: string
    scope: string
    personParty: string
    organizationParty: string
    contact: string
    address: string
    relationship: string
    invitation: string
    taxRate: string
    unit: string
    sequence: string
    entity: string
    record: string
    rule: string
    form: string
  }
}

/** Os mesmos códigos, nomes e identificações nos dois tenants: a única diferença é o tenant. */
export const SHARED = {
  roleCode: 'comercial',
  orgCode: 'ORG-1',
  unitRoot: 'SEDE',
  unitChild: 'VENDAS',
  costCenter: 'CC-1',
  policyName: 'Politica comum',
  personEmail: 'maria.comum@exemplo.invalid',
  taxId: '5000000099',
  inviteEmail: 'convidado.comum@exemplo.invalid',
  entityCode: 'vehicle',
  plate: 'AB-12-CD',
  ruleCode: 'matricula_proibida',
  formCode: 'ficha',
  forbiddenPlate: 'ZZ-99-ZZ',
}

async function must<T>(response: { status(): number; body(): any }, status: number): Promise<T> {
  if (response.status() !== status) {
    throw new Error(
      `Esperado ${status}, obtido ${response.status()}: ${JSON.stringify(response.body())}`
    )
  }
  return response.body().data as T
}

/**
 * Um tenant de demonstração completo: toda a entidade de tenant existe pelo menos uma vez, com
 * códigos e valores iguais aos do outro tenant ("códigos semelhantes").
 */
export async function buildWorld(client: any, label: string, tenant?: Tenant): Promise<World> {
  const t = tenant ?? (await createActiveTenant())
  const admin = await newActor(client, t, true)
  const operator = await newActor(client, t)
  const member = await newActor(client, t)
  const http = api(client, t, admin)

  // Módulos (C03): o mesmo módulo e override nos dois tenants, com plano que os licencia.
  await syncTestRegistry()
  await license(t, ['crm'], ['crm.scoring'])
  await must(await http.post('/api/v1/tenant/modules/crm/enable', {}), 200)
  await must(
    await http.put('/api/v1/tenant/features/crm.scoring', {
      override: true,
      reason: 'Piloto comum',
    }),
    200
  )

  const role = await must<{ id: string }>(
    await http.post('/api/v1/roles', {
      code: SHARED.roleCode,
      name: 'Comercial',
      permissionCodes: ['party.read'],
    }),
    201
  )
  const assignment = await must<{ id: string }>(
    await http.post('/api/v1/role-assignments', {
      membershipId: member.membershipId,
      roleId: role.id,
    }),
    201
  )
  const policy = await must<{ id: string }>(
    await http.post('/api/v1/access-policies', {
      name: SHARED.policyName,
      resource: 'party',
      action: 'read',
      effect: 'ALLOW',
      status: 'DRAFT',
    }),
    201
  )
  const organization = await must<{ id: string }>(
    await http.post('/api/v1/organizations', {
      code: SHARED.orgCode,
      legalName: 'Empresa Comum, Lda.',
      countryCode: 'AO',
      baseCurrency: 'AOA',
    }),
    201
  )
  const unitRoot = await must<{ id: string }>(
    await http.post('/api/v1/organization-units', {
      organizationId: organization.id,
      code: SHARED.unitRoot,
      name: 'Sede',
      type: 'BRANCH',
    }),
    201
  )
  const unitChild = await must<{ id: string }>(
    await http.post('/api/v1/organization-units', {
      organizationId: organization.id,
      parentId: unitRoot.id,
      code: SHARED.unitChild,
      name: 'Vendas',
      type: 'DEPARTMENT',
    }),
    201
  )
  const costCenter = await must<{ id: string }>(
    await http.post('/api/v1/cost-centers', {
      organizationId: organization.id,
      code: SHARED.costCenter,
      name: 'Geral',
    }),
    201
  )
  const teamMember = await must<{ id: string }>(
    await http.post(`/api/v1/organization-units/${unitRoot.id}/members`, {
      membershipId: member.membershipId,
      startsOn: '2026-01-01',
    }),
    201
  )
  const scope = await must<{ id: string }>(
    await http.post('/api/v1/membership-scopes', {
      membershipId: member.membershipId,
      organizationId: organization.id,
      organizationUnitId: unitRoot.id,
      includeDescendants: true,
    }),
    201
  )
  const person = await must<{ id: string; contacts: { id: string }[] }>(
    await http.post('/api/v1/people', {
      givenNames: 'Maria',
      familyName: 'Comum',
      birthDate: '1990-01-01',
      identityType: 'BI',
      identityNumber: '000111222AB',
      contacts: [{ type: 'EMAIL', value: SHARED.personEmail }],
    }),
    201
  )
  const orgParty = await must<{ id: string }>(
    await http.post('/api/v1/organization-parties', {
      legalName: 'Fornecedor Comum, Lda.',
      taxCountry: 'AO',
      taxId: SHARED.taxId,
    }),
    201
  )
  const contact = await must<{ id: string }>(
    await http.post(`/api/v1/parties/${person.id}/contacts`, {
      type: 'PHONE',
      value: '+244 900 111 222',
    }),
    201
  )
  const address = await must<{ id: string }>(
    await http.post(`/api/v1/parties/${orgParty.id}/addresses`, {
      type: 'BILLING',
      line1: 'Rua Comum 1',
      city: 'Luanda',
      countryCode: 'AO',
    }),
    201
  )
  const relationship = await must<{ id: string }>(
    await http.post(`/api/v1/parties/${person.id}/relationships`, {
      targetPartyId: orgParty.id,
      relationshipType: 'REPRESENTANTE',
    }),
    201
  )
  const invitation = await must<{ id: string }>(
    await http.post('/api/v1/invitations', { email: SHARED.inviteEmail }),
    201
  )
  // C09: os mesmos códigos nos dois tenants; só o valor das configurações difere.
  await must(
    await http.put('/api/v1/settings/ui.locale', {
      scopeType: 'TENANT',
      value: label === 'A' ? 'en' : 'pt-PT',
    }),
    200
  )
  await must(
    await http.put('/api/v1/settings/ui.dateFormat', {
      scopeType: 'ORGANIZATION',
      scopeId: organization.id,
      value: 'yyyy-MM-dd',
    }),
    200
  )
  const taxRate = await must<{ id: string }>(
    await http.post('/api/v1/tax-rates', {
      organizationId: organization.id,
      code: 'IVA',
      name: 'IVA normal',
      rate: '14',
      validFrom: '2026-01-01',
      category: 'VAT',
    }),
    201
  )
  const kg = await must<{ id: string }>(
    await http.post('/api/v1/units', {
      code: 'KG',
      name: 'Quilograma',
      dimension: 'MASS',
      precision: 3,
    }),
    201
  )
  await must(
    await http.post('/api/v1/units', {
      code: 'G',
      name: 'Grama',
      dimension: 'MASS',
      precision: 0,
      baseUnitId: kg.id,
      conversionFactor: '0.001',
    }),
    201
  )
  const sequence = await must<{ id: string }>(
    await http.post('/api/v1/sequences', {
      organizationId: organization.id,
      documentType: 'INVOICE',
      series: 'A',
      prefixTemplate: 'FT {SERIES}/{YYYY}/',
    }),
    201
  )
  // C10: a mesma entidade dinâmica, com o mesmo código e o mesmo valor único, nos dois tenants.
  const entity = await must<{ entity: { id: string; version: number } }>(
    await http.post('/api/v1/entity-definitions', {
      code: SHARED.entityCode,
      name: 'Viatura',
      fields: [
        {
          code: 'matricula',
          label: 'Matrícula',
          type: 'TEXT',
          required: true,
          validation: { unique: true },
        },
        { code: 'notas', label: 'Notas', type: 'TEXT', sensitive: true },
        { code: 'condutor', label: 'Condutor', type: 'USER_REFERENCE' },
      ],
    }),
    201
  )
  await must(
    await http.post(`/api/v1/entity-definitions/${entity.entity.id}/publish`, {
      expectedVersion: entity.entity.version,
    }),
    200
  )
  const record = await must<{ id: string }>(
    await http.post(`/api/v1/dynamic/${SHARED.entityCode}/records`, {
      data: { matricula: SHARED.plate, notas: 'comum', condutor: admin.membershipId },
    }),
    201
  )
  // C12: a mesma regra nos dois tenants; uma tentativa recusada deixa a avaliação registada.
  const rule = await must<{ id: string; version: number }>(
    await http.post('/api/v1/rules', {
      entityCode: SHARED.entityCode,
      code: SHARED.ruleCode,
      name: 'Matrícula proibida',
      conditionAst: {
        op: 'eq',
        left: { var: 'resource.matricula' },
        right: { value: SHARED.forbiddenPlate },
      },
      actionAst: { type: 'BLOCK', message: 'Matrícula não permitida', field: 'matricula' },
    }),
    201
  )
  await must(
    await http.post(`/api/v1/rules/${rule.id}/publish`, { expectedVersion: rule.version }),
    200
  )
  await http.post(`/api/v1/dynamic/${SHARED.entityCode}/records`, {
    data: { matricula: SHARED.forbiddenPlate },
  })
  // C11: o mesmo formulário publicado nos dois tenants.
  const form = await must<{ id: string; version: number }>(
    await http.post('/api/v1/forms', {
      entityCode: SHARED.entityCode,
      code: SHARED.formCode,
      name: 'Ficha',
      isDefault: true,
      sections: [
        {
          key: 'dados',
          title: 'Dados',
          columns: 2,
          items: [
            { kind: 'field', field: 'matricula', span: 2, help: 'Única por tenant' },
            { kind: 'field', field: 'condutor' },
          ],
        },
      ],
    }),
    201
  )
  await must(
    await http.post(`/api/v1/forms/${form.id}/publish`, { expectedVersion: form.version }),
    200
  )
  await must(
    await http.put('/api/v1/me/preferences/ui.theme', { value: label === 'A' ? 'dark' : 'light' }),
    200
  )

  return {
    label,
    tenant: t,
    admin,
    operator,
    member,
    http,
    ids: {
      role: role.id,
      assignment: assignment.id,
      policy: policy.id,
      organization: organization.id,
      unitRoot: unitRoot.id,
      unitChild: unitChild.id,
      costCenter: costCenter.id,
      teamMember: teamMember.id,
      scope: scope.id,
      personParty: person.id,
      organizationParty: orgParty.id,
      contact: contact.id,
      address: address.id,
      relationship: relationship.id,
      invitation: invitation.id,
      taxRate: taxRate.id,
      unit: kg.id,
      sequence: sequence.id,
      entity: entity.entity.id,
      record: record.id,
      rule: rule.id,
      form: form.id,
    },
  }
}

/** Um utilizador com membership em ambos os tenants, sem papéis em nenhum (para a troca de tenant). */
export async function crossTenantUser(a: Tenant, b: Tenant) {
  const { user, email } = await createActiveUser()
  const inA = await addMember(a, user.id)
  const inB = await addMember(b, user.id)
  return { user, email, membershipA: inA.id, membershipB: inB.id }
}

export async function grantAdmin(tenant: Tenant, membershipId: string) {
  await iamServices().ensureTenantAdmin.execute(
    serviceTenantContext(tenant.id, 'teste'),
    membershipId
  )
}
