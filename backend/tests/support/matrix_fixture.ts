import { createHash } from 'node:crypto'
import { iamServices } from '#core/permissions/index'
import { serviceTenantContext } from '#core/tenancy/index'
import { automationServices } from '#dynamic/automations/index'
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
    machine: string
    stateRecord: string
    workflow: string
    instance: string
    task: string
    delegation: string
    automation: string
    run: string
    category: string
    product: string
    variant: string
    priceList: string
    priceItem: string
    segment: string
    customer: string
    interaction: string
    quote: string
    quoteLine: string
    order: string
    orderLine: string
    warehouse: string
    location: string
    lot: string
    movement: string
    reservation: string
    shipment: string
    shipmentLine: string
    shipmentOrderLine: string
    contract: string
    supplier: string
    requisition: string
    requisitionLine: string
    purchase: string
    purchaseLine: string
    orderedPurchase: string
    orderedPurchaseLine: string
    goodsReceipt: string
    goodsReceiptLine: string
    invoice: string
    issuedInvoice: string
    invoiceLine: string
    creditNote: string
    creditNoteLine: string
    treasuryAccount: string
    receivable: string
    payable: string
    payment: string
    supplierInvoice: string
    supplierInvoiceLine: string
    secondWarehouse: string
    transfer: string
    transferLine: string
    draftTransfer: string
    draftTransferLine: string
    count: string
    countLine: string
    goodsReturn: string
    returnLine: string
    returnSourceLine: string
    bankAccount: string
    stage: string
    wonStage: string
    lead: string
    opportunity: string
    activity: string
    campaign: string
    campaignMember: string
    exclusion: string
    notification: string
    delivery: string
    document: string
    report: string
    dashboard: string
    widget: string
    exportJob: string
    attachment: string
    resourceAttachment: string
    template: string
    templateVersion: string
    statementBatch: string
    statementLine: string
    matchedLine: string
    reconEntry: string
    reconMatch: string
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
  machineCode: 'ciclo',
  statePlate: 'EF-56-GH',
  workflowCode: 'aprovacao',
  workflowPlate: 'IJ-78-KL',
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
  await license(
    t,
    [
      'crm',
      'catalog',
      'customers',
      'prospecting',
      'notifications',
      'documents',
      'reporting',
      'orders',
      'inventory',
      'invoicing',
      'procurement',
      'finance',
    ],
    ['crm.scoring']
  )
  await must(await http.post('/api/v1/tenant/modules/crm/enable', {}), 200)
  await must(await http.post('/api/v1/tenant/modules/catalog/enable', {}), 200)
  await must(await http.post('/api/v1/tenant/modules/customers/enable', {}), 200)
  await must(await http.post('/api/v1/tenant/modules/orders/enable', {}), 200)
  await must(await http.post('/api/v1/tenant/modules/inventory/enable', {}), 200)
  await must(await http.post('/api/v1/tenant/modules/invoicing/enable', {}), 200)
  await must(await http.post('/api/v1/tenant/modules/procurement/enable', {}), 200)
  await must(await http.post('/api/v1/tenant/modules/finance/enable', {}), 200)
  await must(await http.post('/api/v1/tenant/modules/prospecting/enable', {}), 200)
  await must(await http.post('/api/v1/tenant/modules/notifications/enable', {}), 200)
  await must(await http.post('/api/v1/tenant/modules/documents/enable', {}), 200)
  await must(await http.post('/api/v1/tenant/modules/reporting/enable', {}), 200)
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
  // C13: a mesma máquina de estados nos dois tenants; um registo novo nasce no estado inicial e faz uma transição
  // (estado, histórico e evento de outbox na mesma transacção).
  const machine = await must<{ id: string; version: number }>(
    await http.post('/api/v1/state-machines', {
      entityCode: SHARED.entityCode,
      code: SHARED.machineCode,
      name: 'Ciclo da viatura',
      states: [
        { code: 'activo', label: 'Activo', category: 'INITIAL' },
        { code: 'em_oficina', label: 'Em oficina', category: 'ACTIVE' },
      ],
      transitions: [
        { code: 'enviar', label: 'Enviar para oficina', from: ['activo'], to: 'em_oficina' },
      ],
    }),
    201
  )
  await must(
    await http.post(`/api/v1/state-machines/${machine.id}/publish`, {
      expectedVersion: machine.version,
    }),
    200
  )
  const stateRecord = await must<{ id: string }>(
    await http.post(`/api/v1/dynamic/${SHARED.entityCode}/records`, {
      data: { matricula: SHARED.statePlate },
    }),
    201
  )
  await must(
    await http.post(
      `/api/v1/dynamic/${SHARED.entityCode}/records/${stateRecord.id}/transitions/enviar`,
      { expectedVersion: 1 }
    ),
    200
  )
  // C14: o mesmo workflow nos dois tenants (aprovador: o administrador); quem submete é outro membro. Um processo com a
  // tarefa aberta e uma delegação do administrador para o membro.
  const requester = await newActor(client, t)
  const requesterRole = await must<{ id: string }>(
    await http.post('/api/v1/roles', {
      code: 'solicitante',
      name: 'Solicitante',
      permissionCodes: ['dynamic.read', 'dynamic.create', 'workflow.submit'],
    }),
    201
  )
  await must(
    await http.post('/api/v1/role-assignments', {
      membershipId: requester.membershipId,
      roleId: requesterRole.id,
    }),
    201
  )
  const workflow = await must<{ id: string; version: number }>(
    await http.post('/api/v1/workflows', {
      entityCode: SHARED.entityCode,
      code: SHARED.workflowCode,
      name: 'Aprovação de viatura',
      graph: {
        stages: [
          {
            code: 'chefia',
            label: 'Chefia',
            criteria: 'ALL',
            approvers: [{ type: 'MEMBERSHIP', id: admin.membershipId }],
            dueInHours: 24,
          },
        ],
      },
    }),
    201
  )
  await must(
    await http.post(`/api/v1/workflows/${workflow.id}/publish`, {
      expectedVersion: workflow.version,
    }),
    200
  )
  const requesterHttp = api(client, t, requester)
  const workflowRecord = await must<{ id: string }>(
    await requesterHttp.post(`/api/v1/dynamic/${SHARED.entityCode}/records`, {
      data: { matricula: SHARED.workflowPlate },
    }),
    201
  )
  const submitted = await must<{ instance: { id: string }; tasks: { id: string }[] }>(
    await requesterHttp.post('/api/v1/workflow-instances', {
      entityCode: SHARED.entityCode,
      workflowCode: SHARED.workflowCode,
      recordId: workflowRecord.id,
    }),
    201
  )
  const delegation = await must<{ id: string }>(
    await http.post('/api/v1/approval-delegations', {
      toMembershipId: member.membershipId,
      validUntil: new Date(Date.now() + 7 * 86_400_000).toISOString(),
      reason: 'Substituição comum',
    }),
    201
  )
  // C15: a mesma automação nos dois tenants, com uma execução já despachada (pendente) por um evento posterior à activação.
  const automation = await must<{ id: string; version: number }>(
    await http.post('/api/v1/automations', {
      code: 'enviar_oficina',
      name: 'Enviar para a oficina',
      eventType: 'dynamic.record.state_changed',
      condition: { op: 'eq', left: { var: 'resource.toState' }, right: { value: 'em_oficina' } },
      actions: [
        {
          type: 'dynamic.record.transition',
          params: {
            entityCode: SHARED.entityCode,
            recordId: { from: 'payload.recordId' },
            transition: 'enviar',
          },
        },
      ],
    }),
    201
  )
  await must(
    await http.post(`/api/v1/automations/${automation.id}/activate`, {
      expectedVersion: automation.version,
    }),
    200
  )
  const triggerRecord = await must<{ id: string }>(
    await http.post(`/api/v1/dynamic/${SHARED.entityCode}/records`, {
      data: { matricula: 'MN-90-PQ' },
    }),
    201
  )
  await must(
    await http.post(
      `/api/v1/dynamic/${SHARED.entityCode}/records/${triggerRecord.id}/transitions/enviar`,
      { expectedVersion: 1 }
    ),
    200
  )
  await automationServices().engine.dispatchEvents(serviceTenantContext(t.id, 'matriz'))
  const [run] = await must<{ id: string }[]>(await http.get('/api/v1/automation-runs'), 200)
  if (!run) throw new Error('O cenário não produziu nenhuma execução de automação.')
  // M03: o mesmo catálogo (categoria, produto com variante por omissão, tabela de preços e um item) nos dois tenants.
  const category = await must<{ id: string }>(
    await http.post('/api/v1/product-categories', { code: 'ROUPA', name: 'Roupa' }),
    201
  )
  const catalogProduct = await must<{ id: string; variants: { id: string }[] }>(
    await http.post('/api/v1/products', {
      code: 'CAM-001',
      name: 'Camisola',
      type: 'GOODS',
      baseUnitId: kg.id,
      categoryId: category.id,
    }),
    201
  )
  const variant = catalogProduct.variants[0] as { id: string }
  const priceList = await must<{ id: string }>(
    await http.post('/api/v1/price-lists', {
      organizationId: organization.id,
      name: 'Retalho',
      currency: 'AOA',
      validFrom: '2026-01-01',
    }),
    201
  )
  const priceItem = await must<{ id: string }>(
    await http.post(`/api/v1/price-lists/${priceList.id}/items`, {
      variantId: variant.id,
      unitPrice: '1500.0000',
    }),
    201
  )
  // M01: o mesmo cliente (sobre a Party do cenário), segmento e interacção nos dois tenants.
  const segment = await must<{ id: string }>(
    await http.post('/api/v1/customer-segments', { code: 'VIP', name: 'Clientes VIP' }),
    201
  )
  const customer = await must<{ id: string }>(
    await http.post('/api/v1/customers', {
      partyId: orgParty.id,
      organizationId: organization.id,
      code: 'CLI-001',
      segmentId: segment.id,
      paymentTermDays: 30,
      creditLimit: '1000000.0000',
    }),
    201
  )
  const interaction = await must<{ id: string }>(
    await http.post('/api/v1/interactions', {
      partyId: orgParty.id,
      channel: 'CALL',
      subject: 'Primeiro contacto',
      occurredAt: '2026-10-20T09:00:00Z',
    }),
    201
  )
  // M04: a mesma proposta (enviada e aceite) e a encomenda em rascunho que dela resulta, nos dois tenants.
  for (const [documentType, prefix] of [
    ['QUOTE', 'PRO {SERIES}/{YYYY}/'],
    ['SALES_ORDER', 'ENC {SERIES}/{YYYY}/'],
    ['CREDIT_NOTE', 'NC {SERIES}/{YYYY}/'],
    ['CONTRACT', 'CT {SERIES}/{YYYY}/'],
    ['PURCHASE_REQUISITION', 'REQ {SERIES}/{YYYY}/'],
    ['PURCHASE_ORDER', 'OC {SERIES}/{YYYY}/'],
    ['GOODS_RECEIPT', 'REC {SERIES}/{YYYY}/'],
  ] as const) {
    await must(
      await http.post('/api/v1/sequences', {
        organizationId: organization.id,
        documentType,
        series: 'A',
        prefixTemplate: prefix,
      }),
      201
    )
  }
  const quote = await must<{ id: string }>(
    await http.post('/api/v1/quotes', {
      organizationId: organization.id,
      customerId: customer.id,
      validUntil: new Date(Date.now() + 30 * 86_400_000).toISOString().slice(0, 10),
    }),
    201
  )
  const quoted = await must<{ lines: { id: string }[] }>(
    await http.post(`/api/v1/quotes/${quote.id}/lines`, { variantId: variant.id, quantity: '2' }),
    201
  )
  await must(await http.post(`/api/v1/quotes/${quote.id}/send`, {}), 200)
  const accepted = await must<{ order: { id: string; lines: { id: string }[] } }>(
    await http.post(`/api/v1/quotes/${quote.id}/accept`, {}),
    200
  )
  // M07: o mesmo armazém (com o local PRINCIPAL), lote, ajuste e reserva nos dois tenants.
  const warehouse = await must<{ id: string; locations: { id: string }[] }>(
    await http.post('/api/v1/warehouses', {
      organizationId: organization.id,
      code: 'ARM-1',
      name: 'Central',
    }),
    201
  )
  const location = warehouse.locations[0] as { id: string }
  const yogurt = await must<{ id: string; variants: { id: string }[] }>(
    await http.post('/api/v1/products', {
      code: 'IOG-001',
      name: 'Iogurte',
      type: 'GOODS',
      baseUnitId: kg.id,
      trackingMode: 'LOT',
    }),
    201
  )
  const yogurtVariant = yogurt.variants[0] as { id: string }
  const lot = await must<{ id: string }>(
    await http.post('/api/v1/lots', {
      variantId: yogurtVariant.id,
      code: 'L1',
      expiresOn: '2099-01-01',
    }),
    201
  )
  const movement = await must<{ id: string }>(
    await http.post('/api/v1/stock-adjustments', {
      variantId: yogurtVariant.id,
      locationId: location.id,
      lotId: lot.id,
      quantityDelta: '10',
      unitCost: '2.5',
      reason: 'Contagem inicial',
    }),
    201
  )
  const reservation = await must<{ id: string }>(
    await http.post('/api/v1/stock-reservations', {
      variantId: yogurtVariant.id,
      locationId: location.id,
      lotId: lot.id,
      quantity: '2',
      sourceType: 'MANUAL',
      sourceId: '00000000-0000-4000-8000-0000000000aa',
    }),
    201
  )
  // M04: a mesma encomenda confirmada com uma expedição em rascunho nos dois tenants.
  const shippable = await must<{ id: string }>(
    await http.post('/api/v1/sales-orders', {
      organizationId: organization.id,
      customerId: customer.id,
    }),
    201
  )
  const shippableLines = await must<{ lines: { id: string }[] }>(
    await http.post(`/api/v1/sales-orders/${shippable.id}/lines`, {
      variantId: variant.id,
      quantity: '3',
    }),
    201
  )
  const shippableLine = shippableLines.lines[0] as { id: string }
  await must(await http.post(`/api/v1/sales-orders/${shippable.id}/confirm`, {}), 200)
  const shipment = await must<{ id: string; lines: { id: string }[] }>(
    await http.post('/api/v1/shipments', {
      orderId: shippable.id,
      lines: [{ orderLineId: shippableLine.id, quantity: '2' }],
    }),
    201
  )
  // M05: um contrato, uma factura em rascunho, uma emitida e uma nota de crédito em rascunho sobre esta, nos dois tenants.
  const contract = await must<{ id: string }>(
    await http.post('/api/v1/contracts', {
      organizationId: organization.id,
      partyId: orgParty.id,
      title: 'Manutenção anual',
      startDate: '2026-01-01',
      endDate: '2026-12-31',
      amount: '1200',
    }),
    201
  )
  // M06: um fornecedor, uma requisição, uma encomenda em rascunho, outra confirmada e uma recepção em rascunho, nos dois tenants.
  const supplier = await must<{ id: string }>(
    await http.post('/api/v1/suppliers', {
      partyId: orgParty.id,
      organizationId: organization.id,
      code: 'FOR-1',
      paymentTermDays: 30,
    }),
    201
  )
  const requisition = await must<{ id: string; lines: { id: string }[] }>(
    await http.post('/api/v1/purchase-requisitions', {
      organizationId: organization.id,
      lines: [{ variantId: variant.id, quantity: '5' }],
    }),
    201
  )
  const purchaseLine = { variantId: variant.id, quantity: '10', unitCost: '5', taxRate: '14' }
  const purchaseDraft = await must<{ id: string; lines: { id: string }[] }>(
    await http.post('/api/v1/purchase-orders', { supplierId: supplier.id, lines: [purchaseLine] }),
    201
  )
  const ordered = await must<{ id: string; lines: { id: string }[] }>(
    await http.post('/api/v1/purchase-orders', { supplierId: supplier.id, lines: [purchaseLine] }),
    201
  )
  await must(await http.post(`/api/v1/purchase-orders/${ordered.id}/confirm`, {}), 200)
  const goodsReceipt = await must<{ id: string; lines: { id: string }[] }>(
    await http.post('/api/v1/goods-receipts', {
      purchaseOrderId: ordered.id,
      warehouseId: warehouse.id,
      lines: [{ purchaseLineId: (ordered.lines[0] as { id: string }).id, quantity: '3' }],
    }),
    201
  )
  const manualLine = {
    description: 'Serviço de consultoria',
    quantity: '2',
    unitPrice: '50',
    taxRate: '14',
  }
  const invoiceDraft = await must<{ id: string }>(
    await http.post('/api/v1/invoices', {
      organizationId: organization.id,
      customerId: customer.id,
      lines: [manualLine],
    }),
    201
  )
  const invoiceIssued = await must<{ id: string; lines: { id: string }[] }>(
    await http.post('/api/v1/invoices', {
      organizationId: organization.id,
      customerId: customer.id,
      lines: [manualLine],
    }),
    201
  )
  await must(await http.post(`/api/v1/invoices/${invoiceIssued.id}/issue`, {}), 200)
  const creditNote = await must<{ id: string; lines: { id: string }[] }>(
    await http.post('/api/v1/credit-notes', {
      invoiceId: invoiceIssued.id,
      reason: 'Desconto comercial',
      lines: [
        {
          invoiceLineId: (invoiceIssued.lines[0] as { id: string }).id,
          quantity: '1',
        },
      ],
    }),
    201
  )
  // M09: uma segunda nota de crédito, emitida, para haver um crédito aplicado ao recebível.
  const issuedCreditNote = await must<{ id: string }>(
    await http.post('/api/v1/credit-notes', {
      invoiceId: invoiceIssued.id,
      reason: 'Acerto comercial',
      lines: [{ invoiceLineId: (invoiceIssued.lines[0] as { id: string }).id, quantity: '1' }],
    }),
    201
  )
  await must(await http.post(`/api/v1/credit-notes/${issuedCreditNote.id}/issue`, {}), 200)
  // M09: uma conta, o recebível da factura emitida, um pagamento em rascunho, uma factura de fornecedor em rascunho e outra
  // validada (que gera o pagável), nos dois tenants.
  const treasuryAccount = await must<{ id: string }>(
    await http.post('/api/v1/treasury-accounts', {
      organizationId: organization.id,
      code: 'CAIXA',
      name: 'Caixa central',
      type: 'CASH',
    }),
    201
  )
  const receivables = await must<{ id: string; sourceId: string }[]>(
    await http.get('/api/v1/receivables?limit=200'),
    200
  )
  const receivable = receivables.find((r) => r.sourceId === invoiceIssued.id) as { id: string }
  const payment = await must<{ id: string }>(
    await http.post('/api/v1/payments', {
      organizationId: organization.id,
      direction: 'INBOUND',
      partyId: orgParty.id,
      treasuryAccountId: treasuryAccount.id,
      amount: '10',
      allocations: [{ receivableId: receivable.id, amount: '10' }],
    }),
    201
  )
  const confirmedPayment = await must<{ id: string }>(
    await http.post('/api/v1/payments', {
      organizationId: organization.id,
      direction: 'INBOUND',
      partyId: orgParty.id,
      treasuryAccountId: treasuryAccount.id,
      amount: '5',
      allocations: [{ receivableId: receivable.id, amount: '5' }],
    }),
    201
  )
  await must(await http.post(`/api/v1/payments/${confirmedPayment.id}/confirm`, {}), 200)
  const supplierInvoiceLine = { description: 'Serviço externo', quantity: '1', unitPrice: '10' }
  const supplierInvoice = await must<{ id: string; lines: { id: string }[] }>(
    await http.post('/api/v1/supplier-invoices', {
      supplierId: supplier.id,
      externalNumber: 'FF-001',
      lines: [supplierInvoiceLine],
    }),
    201
  )
  const validatedInvoice = await must<{ id: string }>(
    await http.post('/api/v1/supplier-invoices', {
      supplierId: supplier.id,
      externalNumber: 'FF-002',
      lines: [supplierInvoiceLine],
    }),
    201
  )
  await must(await http.post(`/api/v1/supplier-invoices/${validatedInvoice.id}/validate`, {}), 200)
  const payables = await must<{ id: string; sourceId: string }[]>(
    await http.get('/api/v1/payables?limit=200'),
    200
  )
  const payable = payables.find((r) => r.sourceId === validatedInvoice.id) as { id: string }
  // M02: uma lead, uma oportunidade (com actividade e histórico), uma campanha com a lead como destinatária e uma
  // exclusão de marketing, nos dois tenants.
  const stages = await must<{ id: string; terminal: boolean; outcome: string | null }[]>(
    await http.get('/api/v1/pipeline-stages'),
    200
  )
  const openStage = stages.find((x) => !x.terminal) as { id: string }
  const wonStage = stages.find((x) => x.outcome === 'WON') as { id: string }
  const lead = await must<{ id: string }>(
    await http.post('/api/v1/leads', {
      name: 'Maria Silva',
      source: 'web',
      email: 'maria@exemplo.invalid',
      consentStatus: 'OPT_IN',
    }),
    201
  )
  const opportunity = await must<{ id: string }>(
    await http.post('/api/v1/opportunities', {
      name: 'Oportunidade comum',
      customerId: customer.id,
      expectedValue: '100',
    }),
    201
  )
  const activity = await must<{ id: string }>(
    await http.post(`/api/v1/opportunities/${opportunity.id}/activities`, {
      kind: 'CALL',
      subject: 'Chamada inicial',
    }),
    201
  )
  const campaign = await must<{ id: string }>(
    await http.post('/api/v1/campaigns', {
      name: 'Campanha comum',
      channel: 'EMAIL',
      startsAt: '2026-01-01T00:00:00Z',
    }),
    201
  )
  await must(
    await http.post(`/api/v1/campaigns/${campaign.id}/members`, { leadIds: [lead.id] }),
    201
  )
  const campaignMembers = await must<{ id: string }[]>(
    await http.get(`/api/v1/campaigns/${campaign.id}/members`),
    200
  )
  const exclusion = await must<{ id: string }>(
    await http.post('/api/v1/marketing-exclusions', {
      kind: 'EMAIL',
      value: 'nunca@exemplo.invalid',
    }),
    201
  )
  // S02: um aviso manual ao administrador (pedido, entrega interna e notificação no centro) e uma preferência.
  await must(
    await http.post('/api/v1/notification-requests', {
      typeCode: 'system.message',
      recipientMembershipIds: [admin.membershipId],
      title: 'Aviso comum',
      body: 'Texto comum aos dois tenants',
    }),
    201
  )
  await must(
    await http.put('/api/v1/notification-preferences', {
      preferences: [{ typeCode: 'crm.lead.converted', channel: 'IN_APP', enabled: false }],
    }),
    200
  )
  const notifications = await must<{ id: string }[]>(await http.get('/api/v1/notifications'), 200)
  const deliveries = await must<{ id: string }[]>(
    await http.get('/api/v1/notification-deliveries'),
    200
  )
  // S01: um ficheiro disponível ligado a um documento e ao cliente, e um modelo com uma versão publicada.
  const fileBytes = Buffer.from('Ficheiro comum aos dois tenants\n')
  const prepared = await must<{ id: string; uploadPath: string }>(
    await http.post('/api/v1/attachments/prepare', {
      fileName: 'comum.txt',
      mimeType: 'text/plain',
      sizeBytes: fileBytes.length,
      checksum: createHash('sha256').update(fileBytes).digest('hex'),
    }),
    201
  )
  const sent = await http.putRaw(prepared.uploadPath, fileBytes)
  if (sent.status !== 200) throw new Error(`upload: ${sent.status} ${sent.buffer.toString()}`)
  await must(await http.post(`/api/v1/attachments/${prepared.id}/complete`, {}), 200)
  const document = await must<{ id: string }>(
    await http.post('/api/v1/documents', {
      title: 'Documento comum',
      attachmentId: prepared.id,
      visibility: 'TENANT',
    }),
    201
  )
  const loose = await must<{ id: string }>(
    await http.post('/api/v1/attachments/prepare', {
      fileName: 'solto.txt',
      mimeType: 'text/plain',
      sizeBytes: fileBytes.length,
      checksum: createHash('sha256').update(fileBytes).digest('hex'),
    }),
    201
  )
  await http.putRaw(`/api/v1/attachments/${loose.id}/content`, fileBytes)
  await must(await http.post(`/api/v1/attachments/${loose.id}/complete`, {}), 200)
  const resourceAttachment = await must<{ id: string }>(
    await http.post('/api/v1/resource-attachments', {
      resourceType: 'customer',
      resourceId: customer.id,
      attachmentId: loose.id,
      category: 'contrato',
    }),
    201
  )
  const template = await must<{ id: string }>(
    await http.post('/api/v1/templates', {
      code: 'modelo_comum',
      name: 'Modelo comum',
      channel: 'DOCUMENT',
    }),
    201
  )
  const templateVersion = await must<{ id: string }>(
    await http.post(`/api/v1/templates/${template.id}/versions`, {
      body: 'Olá {{cliente}}',
      variableSchema: { variables: [{ name: 'cliente', label: 'Cliente', type: 'string' }] },
    }),
    201
  )
  await must(
    await http.post(`/api/v1/templates/${template.id}/versions/${templateVersion.id}/publish`, {}),
    200
  )
  // S04: um relatório publicado, um painel com um widget, uma exportação em fila e o índice de pesquisa.
  const report = await must<{ id: string }>(
    await http.post('/api/v1/reports', {
      code: 'vendas_comum',
      name: 'Vendas por moeda',
      datasetCode: 'sales_documents',
      visibility: 'TENANT',
      query: {
        groupBy: ['currency'],
        measures: [{ fn: 'sum', field: 'amount', alias: 'total' }],
      },
    }),
    201
  )
  await must(await http.post(`/api/v1/reports/${report.id}/publish`, {}), 200)
  const dashboard = await must<{ id: string }>(
    await http.post('/api/v1/dashboards', { name: 'Painel comum', visibility: 'TENANT' }),
    201
  )
  const widget = await must<{ id: string }>(
    await http.post(`/api/v1/dashboards/${dashboard.id}/widgets`, {
      title: 'Vendas',
      type: 'KPI',
      reportId: report.id,
    }),
    201
  )
  const exportJob = await must<{ id: string }>(
    await http.post('/api/v1/exports', { reportId: report.id, format: 'CSV' }),
    202
  )
  await must(await http.post('/api/v1/search/reindex', {}), 200)
  // Conciliação: uma conta bancária com um recebimento confirmado (1), um extracto de duas linhas (+1 e -3) e a primeira
  // linha já conciliada com o movimento; a segunda fica por conciliar.
  const bankAccount = await must<{ id: string }>(
    await http.post('/api/v1/treasury-accounts', {
      organizationId: organization.id,
      code: 'BANCO',
      name: 'Banco principal',
      type: 'BANK',
    }),
    201
  )
  const bankPayment = await must<{ id: string }>(
    await http.post('/api/v1/payments', {
      organizationId: organization.id,
      direction: 'INBOUND',
      partyId: orgParty.id,
      treasuryAccountId: bankAccount.id,
      amount: '1',
      allocations: [{ receivableId: receivable.id, amount: '1' }],
    }),
    201
  )
  await must(await http.post(`/api/v1/payments/${bankPayment.id}/confirm`, {}), 200)
  const today = new Date().toISOString().slice(0, 10)
  const imported = await must<{ batch: { id: string } }>(
    await http.post('/api/v1/reconciliations/imports', {
      accountId: bankAccount.id,
      fileName: 'extracto.csv',
      lines: [
        { occurredOn: today, amount: '1', description: 'Recebimento' },
        { occurredOn: today, amount: '-3', description: 'Comissão' },
      ],
    }),
    201
  )
  const statementLines = await must<{ id: string; amountSigned: string }[]>(
    await http.get(`/api/v1/reconciliations/lines?accountId=${bankAccount.id}`),
    200
  )
  const matchedLine = statementLines.find((l) => l.amountSigned === '1.0000') as { id: string }
  const openLine = statementLines.find((l) => l.amountSigned === '-3.0000') as { id: string }
  const reconEntries = await must<{ id: string }[]>(
    await http.get(`/api/v1/reconciliations/entries?accountId=${bankAccount.id}`),
    200
  )
  const reconMatch = await must<{ id: string }>(
    await http.post('/api/v1/reconciliations/matches', {
      statementLineId: matchedLine.id,
      treasuryEntryId: reconEntries[0].id,
    }),
    201
  )
  // M08: um segundo armazém, uma transferência expedida e parcialmente recebida, outra em rascunho, uma contagem aberta
  // (no segundo armazém, para não congelar o das outras fluxos) e uma devolução a fornecedor em rascunho.
  for (const [documentType, prefix] of [
    ['STOCK_TRANSFER', 'TRF {SERIES}/{YYYY}/'],
    ['STOCK_COUNT', 'INV {SERIES}/{YYYY}/'],
    ['GOODS_RETURN', 'DEV {SERIES}/{YYYY}/'],
  ] as const) {
    await must(
      await http.post('/api/v1/sequences', {
        organizationId: organization.id,
        documentType,
        series: 'A',
        prefixTemplate: prefix,
      }),
      201
    )
  }
  const secondWarehouse = await must<{ id: string; locations: { id: string }[] }>(
    await http.post('/api/v1/warehouses', {
      organizationId: organization.id,
      code: 'ARM-2',
      name: 'Secundário',
    }),
    201
  )
  await must(
    await http.post('/api/v1/stock-adjustments', {
      variantId: variant.id,
      locationId: location.id,
      quantityDelta: '20',
      unitCost: '3',
      reason: 'Stock para transferir',
    }),
    201
  )
  const transferBody = {
    sourceWarehouseId: warehouse.id,
    destinationWarehouseId: secondWarehouse.id,
    lines: [{ variantId: variant.id, quantity: '5' }],
  }
  const transferDraft = await must<{ id: string; lines: { id: string }[] }>(
    await http.post('/api/v1/stock-transfers', transferBody),
    201
  )
  const dispatched = await must<{ id: string; lines: { id: string }[] }>(
    await http.post('/api/v1/stock-transfers', transferBody),
    201
  )
  await must(await http.post(`/api/v1/stock-transfers/${dispatched.id}/dispatch`, {}), 200)
  await must(
    await http.post(`/api/v1/stock-transfers/${dispatched.id}/receive`, {
      lines: [{ lineId: (dispatched.lines[0] as { id: string }).id, quantity: '2' }],
    }),
    200
  )
  const counting = await must<{ id: string }>(
    await http.post('/api/v1/stock-counts', { warehouseId: secondWarehouse.id }),
    201
  )
  const openCount = await must<{ id: string; lines: { id: string }[] }>(
    await http.post(`/api/v1/stock-counts/${counting.id}/open`, {}),
    200
  )
  const receiptToReturn = await must<{ id: string; lines: { id: string }[] }>(
    await http.post('/api/v1/goods-receipts', {
      purchaseOrderId: ordered.id,
      warehouseId: warehouse.id,
      lines: [{ purchaseLineId: (ordered.lines[0] as { id: string }).id, quantity: '2' }],
    }),
    201
  )
  await must(await http.post(`/api/v1/goods-receipts/${receiptToReturn.id}/post`, {}), 200)
  const sourceLines = await must<{ sourceLineId: string }[]>(
    await http.get(
      `/api/v1/goods-returns/source-lines?direction=SUPPLIER&sourceDocumentId=${receiptToReturn.id}`
    ),
    200
  )
  const goodsReturn = await must<{ id: string; lines: { id: string }[] }>(
    await http.post('/api/v1/goods-returns', {
      direction: 'SUPPLIER',
      sourceDocumentId: receiptToReturn.id,
      warehouseId: warehouse.id,
      reason: 'Mercadoria com defeito',
      lines: [
        { sourceLineId: (sourceLines[0] as { sourceLineId: string }).sourceLineId, quantity: '1' },
      ],
    }),
    201
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
      machine: machine.id,
      stateRecord: stateRecord.id,
      workflow: workflow.id,
      instance: submitted.instance.id,
      task: submitted.tasks[0]?.id as string,
      delegation: delegation.id,
      automation: automation.id,
      run: run.id,
      category: category.id,
      product: catalogProduct.id,
      variant: variant.id,
      priceList: priceList.id,
      priceItem: priceItem.id,
      segment: segment.id,
      customer: customer.id,
      interaction: interaction.id,
      quote: quote.id,
      quoteLine: (quoted.lines[0] as { id: string }).id,
      order: accepted.order.id,
      orderLine: (accepted.order.lines[0] as { id: string }).id,
      warehouse: warehouse.id,
      location: location.id,
      lot: lot.id,
      movement: movement.id,
      reservation: reservation.id,
      shipment: shipment.id,
      shipmentLine: (shipment.lines[0] as { id: string }).id,
      shipmentOrderLine: shippableLine.id,
      contract: contract.id,
      supplier: supplier.id,
      requisition: requisition.id,
      requisitionLine: (requisition.lines[0] as { id: string }).id,
      purchase: purchaseDraft.id,
      purchaseLine: (purchaseDraft.lines[0] as { id: string }).id,
      orderedPurchase: ordered.id,
      orderedPurchaseLine: (ordered.lines[0] as { id: string }).id,
      goodsReceipt: goodsReceipt.id,
      goodsReceiptLine: (goodsReceipt.lines[0] as { id: string }).id,
      invoice: invoiceDraft.id,
      issuedInvoice: invoiceIssued.id,
      invoiceLine: (invoiceIssued.lines[0] as { id: string }).id,
      creditNote: creditNote.id,
      creditNoteLine: (creditNote.lines[0] as { id: string }).id,
      treasuryAccount: treasuryAccount.id,
      receivable: receivable.id,
      payable: payable.id,
      payment: payment.id,
      supplierInvoice: supplierInvoice.id,
      supplierInvoiceLine: (supplierInvoice.lines[0] as { id: string }).id,
      secondWarehouse: secondWarehouse.id,
      transfer: dispatched.id,
      transferLine: (dispatched.lines[0] as { id: string }).id,
      draftTransfer: transferDraft.id,
      draftTransferLine: (transferDraft.lines[0] as { id: string }).id,
      count: openCount.id,
      countLine: (openCount.lines[0] as { id: string }).id,
      goodsReturn: goodsReturn.id,
      returnLine: (goodsReturn.lines[0] as { id: string }).id,
      returnSourceLine: (sourceLines[0] as { sourceLineId: string }).sourceLineId,
      bankAccount: bankAccount.id,
      stage: openStage.id,
      wonStage: wonStage.id,
      lead: lead.id,
      opportunity: opportunity.id,
      activity: activity.id,
      campaign: campaign.id,
      campaignMember: (campaignMembers[0] as { id: string }).id,
      exclusion: exclusion.id,
      document: document.id,
      report: report.id,
      dashboard: dashboard.id,
      widget: widget.id,
      exportJob: exportJob.id,
      attachment: prepared.id,
      resourceAttachment: resourceAttachment.id,
      template: template.id,
      templateVersion: templateVersion.id,
      notification: (notifications[0] as { id: string }).id,
      delivery: (deliveries[0] as { id: string }).id,
      statementBatch: imported.batch.id,
      statementLine: openLine.id,
      matchedLine: matchedLine.id,
      reconEntry: reconEntries[0].id,
      reconMatch: reconMatch.id,
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
