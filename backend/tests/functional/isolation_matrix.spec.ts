import { test } from '@japa/runner'
import db from '@adonisjs/lucid/services/db'
import {
  as,
  cleanDatabase,
  createRole,
  memberWithRoles,
  signIn,
  tenantWithAdmin,
  type Session,
} from '#tests/support/fixtures'
import { runInTenant } from '#modules/tenancy/index'
import { postStock } from '#modules/inventory/index'

const PDF = Buffer.from('%PDF-1.4\n%%EOF\n')

function upload(client: any, s: Session, subjectType: string, subjectId: string) {
  return client
    .post('/api/v1/attachments')
    .header('cookie', s.cookie)
    .header('x-xsrf-token', s.xsrf)
    .header('x-tenant-id', s.tenantId)
    .field('subjectType', subjectType)
    .field('subjectId', subjectId)
    .file('file', PDF, { filename: 'a.pdf' })
}

/** Empresa A com um registo de cada tipo; devolve os ids. */
async function populate(client: any) {
  const { tenant, admin } = await tenantWithAdmin()
  const s = await signIn(client, admin.email, tenant.id)
  const ok = (r: any, status = 201) => {
    if (r.status() !== status) throw new Error(JSON.stringify(r.body()))
    return r.body().data
  }
  const le = ok(
    await as(client, s).post('/api/v1/organization/legal-entities', {
      code: 'LEA',
      legalName: 'Entidade A, Lda.',
      taxId: '5000000101',
      countryCode: 'AO',
      functionalCurrency: 'AOA',
    })
  )
  const branch = ok(
    await as(client, s).post('/api/v1/organization/branches', {
      code: 'BRA',
      name: 'Filial A',
      legalEntityId: le.id,
    })
  )
  const role = await createRole(client, s, 'aprovador_a', ['members.read'])
  const approver = await memberWithRoles(client, s, [role.id])
  const wf = ok(
    await as(client, s).post('/api/v1/approvals/workflows', {
      code: 'WFA',
      name: 'Workflow A',
      subjectType: 'manual',
      steps: [{ name: 'Etapa', approverType: 'MEMBER', approverMembershipId: approver.memberId }],
    })
  )
  ok(
    await as(client, s).post(`/api/v1/approvals/workflows/${wf.id}/publish`, {
      expectedVersion: wf.version,
    }),
    200
  )
  const request = ok(
    await as(client, s).post('/api/v1/approvals/requests', { workflowId: wf.id, title: 'Pedido A' })
  )
  const delegation = ok(
    await as(client, approver.session).post('/api/v1/approvals/delegations', {
      delegateMembershipId: (await as(client, s).get('/api/v1/context')).body().data.membershipId,
      endsAt: new Date(Date.now() + 86_400_000).toISOString(),
      reason: 'Ausência',
    })
  )
  const attachment = ok(await upload(client, s, 'legal_entity', le.id))
  const notification = (await as(client, approver.session).get('/api/v1/me/notifications')).body()
    .data[0]
  const rate = ok(
    await as(client, s).post('/api/v1/exchange-rates', {
      fromCurrency: 'USD',
      toCurrency: 'AOA',
      rate: '900',
      validOn: '2026-01-02',
    })
  )
  const series = ok(
    await as(client, s).post('/api/v1/document-series', {
      legalEntityId: le.id,
      documentType: 'INVOICE',
      code: 'FTA',
    })
  )
  const calendar = ok(
    await as(client, s).post('/api/v1/calendars', {
      code: 'CALA',
      name: 'Calendário A',
      countryCode: 'AO',
    })
  )
  const holiday = ok(
    await as(client, s).post(`/api/v1/calendars/${calendar.id}/holidays`, {
      date: '2026-11-11',
      name: 'Independência',
    })
  )
  const bank = ok(
    await as(client, s).post('/api/v1/bank-accounts', {
      legalEntityId: le.id,
      holderName: 'Entidade A, Lda.',
      bankName: 'Banco A',
      accountNumber: '123456789',
      currency: 'AOA',
    })
  )
  ok(
    await as(client, s).put('/api/v1/company/profile', {
      expectedVersion: 0,
      displayName: 'Marca A',
    }),
    200
  )
  // Contabilidade: série de lançamentos, plano com duas contas, exercício, diário e um lançamento contabilizado.
  const jSeries = ok(
    await as(client, s).post('/api/v1/document-series', {
      legalEntityId: le.id,
      documentType: 'JOURNAL',
      code: 'DGA',
    })
  )
  const chart = ok(
    await as(client, s).post('/api/v1/accounting/charts', {
      legalEntityId: le.id,
      code: 'PCA',
      name: 'Plano A',
      jurisdiction: 'AO',
    })
  )
  const acc = async (code: string, level: string, parentId: string | null, postable = false) =>
    ok(
      await as(client, s).post('/api/v1/accounting/accounts', {
        chartId: chart.id,
        code,
        name: `Conta ${code}`,
        level,
        nature: 'ASSET',
        parentId,
        postable,
      })
    )
  const cls = await acc('1', 'CLASS', null)
  const accountA = await acc('11', 'ACCOUNT', cls.id, true)
  const accountB = await acc('12', 'ACCOUNT', cls.id, true)
  const fy = ok(
    await as(client, s).post('/api/v1/accounting/fiscal-years', {
      legalEntityId: le.id,
      code: '2026',
      startDate: '2026-01-01',
      endDate: '2026-12-31',
    })
  )
  const journal = ok(
    await as(client, s).post('/api/v1/accounting/journals', {
      legalEntityId: le.id,
      code: 'DGA',
      name: 'Diário A',
      type: 'GENERAL',
      documentSeriesId: jSeries.id,
    })
  )
  const entry = ok(
    await as(client, s).post('/api/v1/accounting/entries', {
      legalEntityId: le.id,
      journalId: journal.id,
      entryDate: '2026-02-10',
      description: 'Lançamento A',
      lines: [
        { accountId: accountA.id, debit: '10' },
        { accountId: accountB.id, credit: '10' },
      ],
    })
  )
  const rule = ok(
    await as(client, s).post('/api/v1/accounting/posting-rules', {
      legalEntityId: le.id,
      code: 'REGA',
      name: 'Regra A',
      source: 'SALES_INVOICE',
      event: 'ISSUED',
      journalId: journal.id,
      validFrom: '2026-01-01',
      lines: [
        { side: 'DEBIT', accountId: accountA.id, amountKey: 'total' },
        { side: 'CREDIT', accountId: accountB.id, amountKey: 'total' },
      ],
    })
  )
  const postingEvent = ok(
    await as(client, s).post('/api/v1/accounting/posting-events', {
      legalEntityId: le.id,
      source: 'SALES_INVOICE',
      event: 'ISSUED',
      sourceRef: 'FT A1',
      occurredOn: '2026-02-11',
      amounts: { total: '5' },
    })
  )
  const period = (await as(client, s).get(`/api/v1/accounting/fiscal-years/${fy.id}`)).body().data
    .periods[2]
  const dimension = ok(
    await as(client, s).post('/api/v1/accounting/dimensions', { code: 'PRJA', name: 'Projecto A' })
  )
  const dimValue = ok(
    await as(client, s).post(`/api/v1/accounting/dimensions/${dimension.id}/values`, {
      code: 'V1',
      name: 'Valor A',
    })
  )[0]
  const allocKey = ok(
    await as(client, s).post('/api/v1/accounting/allocation-keys', {
      legalEntityId: le.id,
      code: 'KA',
      name: 'Chave A',
      lines: [{ percent: '100', values: { [dimension.id]: dimValue.id } }],
    })
  )
  ok(
    await as(client, s).put(`/api/v1/accounting/entries/${entry.id}/lines/1/allocations`, {
      keyId: allocKey.id,
    }),
    200
  )
  const assetClass = ok(
    await as(client, s).post('/api/v1/accounting/fixed-asset-classes', {
      legalEntityId: le.id,
      code: 'FA',
      name: 'Classe A',
      usefulLifeMonths: 12,
      journalId: journal.id,
      assetAccountId: accountA.id,
      accumulatedAccountId: accountB.id,
      expenseAccountId: accountA.id,
      gainAccountId: accountB.id,
      lossAccountId: accountA.id,
    })
  )
  const asset = ok(
    await as(client, s).post('/api/v1/accounting/fixed-assets', {
      classId: assetClass.id,
      number: 'AF-A',
      name: 'Activo A',
      acquisitionDate: '2026-01-01',
      cost: '12',
    })
  )
  const schedule = ok(
    await as(client, s).post('/api/v1/accounting/adjustment-schedules', {
      legalEntityId: le.id,
      code: 'RA',
      name: 'Plano A',
      kind: 'DEFERRAL',
      journalId: journal.id,
      startMonth: '2026-01',
      months: 2,
      totalAmount: '10',
      debitAccountId: accountA.id,
      creditAccountId: accountB.id,
    })
  )
  const provision = ok(
    await as(client, s).post('/api/v1/accounting/provisions', {
      legalEntityId: le.id,
      code: 'PA',
      name: 'Provisão A',
      journalId: journal.id,
      expenseAccountId: accountA.id,
      provisionAccountId: accountB.id,
      reversalAccountId: accountA.id,
    })
  )
  const stmtTemplate = ok(
    await as(client, s).post('/api/v1/accounting/statement-templates', {
      chartId: chart.id,
      code: 'BA',
      name: 'Balanço A',
      kind: 'BALANCE_SHEET',
      lines: [{ kind: 'ACCOUNTS', code: 'A1', label: 'Contas', mappings: [{ prefix: '1' }] }],
    })
  )
  const stmtNote = ok(
    await as(client, s).post('/api/v1/accounting/statement-notes', {
      fiscalYearId: fy.id,
      number: 1,
      title: 'Nota A',
      body: 'Texto A',
    })
  )
  const closeTask = ok(
    await as(client, s).post(`/api/v1/accounting/periods/${period.id}/tasks`, {
      title: 'Tarefa A',
    })
  )[0]
  const employee = ok(
    await as(client, s).post('/api/v1/hr/employees', {
      code: 'COL-A',
      fullName: 'Colaborador A',
      legalEntityId: le.id,
      branchId: branch.id,
      hireDate: '2026-01-05',
      taxId: '004567890LA041',
    })
  )
  // Recrutamento (7.2): vaga aberta (aprovada por outro membro), candidato, candidatura, proposta e onboarding.
  const hrDept = ok(
    await as(client, s).post('/api/v1/organization/departments', {
      code: 'DPA',
      name: 'Departamento A',
      legalEntityId: le.id,
    })
  )
  const hrPosition = ok(
    await as(client, s).post('/api/v1/organization/positions', {
      code: 'POA',
      name: 'Cargo A',
      departmentId: hrDept.id,
    })
  )
  const hrApprove = await createRole(client, s, 'aprova_rh_a', ['hr.recruitment.approve'])
  ok(
    await as(client, s).post(`/api/v1/members/${approver.memberId}/roles`, {
      roleId: hrApprove.id,
      scopeType: 'TENANT',
    }),
    200
  )
  const reqDraft = ok(
    await as(client, s).post('/api/v1/hr/requisitions', {
      code: 'VAGA-A',
      title: 'Vaga A',
      legalEntityId: le.id,
      departmentId: hrDept.id,
      positionId: hrPosition.id,
      quantity: 1,
      currency: 'AOA',
      salaryMin: '100000',
      salaryMax: '200000',
    })
  )
  const reqSub = ok(
    await as(client, s).post(`/api/v1/hr/requisitions/${reqDraft.id}/submit`, {
      expectedVersion: reqDraft.version,
    }),
    200
  )
  const requisition = ok(
    await as(client, approver.session).post(`/api/v1/hr/requisitions/${reqDraft.id}/decision`, {
      decision: 'APPROVE',
      expectedVersion: reqSub.version,
    }),
    200
  )
  const candidate = ok(
    await as(client, s).post('/api/v1/hr/candidates', {
      fullName: 'Candidato A',
      email: 'cand.a@exemplo.ao',
    })
  )
  const application = ok(
    await as(client, s).post('/api/v1/hr/applications', {
      requisitionId: requisition.id,
      candidateId: candidate.id,
    })
  )
  const screening = ok(
    await as(client, s).post(`/api/v1/hr/applications/${application.id}/stage`, {
      stage: 'SCREENING',
      expectedVersion: application.version,
    }),
    200
  )
  const interview = ok(
    await as(client, s).post(`/api/v1/hr/applications/${application.id}/interviews`, {
      scheduledAt: '2030-01-10T10:00:00Z',
      mode: 'ONSITE',
      interviewerMembershipId: approver.memberId,
    })
  )
  const offer = ok(
    await as(client, s).post(`/api/v1/hr/applications/${application.id}/offers`, {
      salary: '150000',
      startDate: '2030-02-01',
    })
  )
  const onboardingTask = ok(
    await as(client, s).post(`/api/v1/hr/employees/${employee.id}/onboarding`, {
      category: 'DOCUMENTS',
      title: 'Entregar documentos',
    })
  )
  void screening
  const leavePolicy = ok(
    await as(client, s).post('/api/v1/hr/leave/policies', {
      code: 'FERIAS-A',
      name: 'Férias A',
      calendarId: calendar.id,
      annualDays: '22',
      firstYearRule: 'FULL',
      legalReference: 'Política de teste',
      validFrom: '2025-01-01',
    })
  )
  const leaveType = ok(
    await as(client, s).post('/api/v1/hr/leave/types', {
      code: 'FER-A',
      name: 'Férias A',
      category: 'VACATION',
      paid: true,
      deductsBalance: false,
      counting: 'CALENDAR_DAYS',
    })
  )
  const payComponent = ok(
    await as(client, s).post('/api/v1/hr/pay-components', {
      code: 'SUB-A',
      name: 'Subsídio A',
      kind: 'EARNING',
      category: 'ALLOWANCE',
      calculation: 'FIXED',
    })
  )
  const compProposal = ok(
    await as(client, s).post(`/api/v1/hr/employees/${employee.id}/compensation/proposals`, {
      effectiveDate: '2026-02-01',
      reason: 'Proposta A',
      lines: [{ componentId: payComponent.id, action: 'SET', amount: '1000' }],
    })
  )
  const ruleSet = ok(
    await as(client, s).post('/api/v1/hr/payroll/rule-sets', {
      code: 'REGRAS-A',
      name: 'Regras A',
      currency: 'AOA',
      validFrom: '2026-01-01',
      inssEmployeeRate: '1',
      inssEmployerRate: '1',
      baseIrtSubject: true,
      baseInssSubject: true,
      irtBaseDeductsInss: false,
      dayBasis: 'FIXED_30',
      legalReference: 'Valores de teste',
      brackets: [{ lower: '0', upper: null, fixedAmount: '0', rate: '0', excessOver: '0' }],
    })
  )
  const payrollRun = ok(
    await as(client, s).post('/api/v1/hr/payroll/runs', {
      legalEntityId: employee.legalEntityId,
      period: '2026-03',
      kind: 'EXTRA',
    })
  )
  const competency = ok(
    await as(client, s).post('/api/v1/hr/training/competencies', {
      code: 'COMP-A',
      name: 'Competência A',
    })
  )
  const course = ok(
    await as(client, s).post('/api/v1/hr/training/courses', {
      code: 'CUR-A',
      name: 'Curso A',
      mode: 'INTERNAL',
      durationHours: '8',
    })
  )
  const trainingSession = ok(
    await as(client, s).post('/api/v1/hr/training/sessions', {
      courseId: course.id,
      startsOn: '2026-03-01',
      endsOn: '2026-03-02',
    })
  )
  const certificate = ok(
    await as(client, s).post(`/api/v1/hr/employees/${employee.id}/certificates`, {
      name: 'Certificado A',
      issuer: 'Entidade A',
      issuedOn: '2026-01-10',
    })
  )
  const disciplinaryCase = ok(
    await as(client, s).post(`/api/v1/hr/employees/${employee.id}/discipline/cases`, {
      category: 'OTHER',
      occurredOn: '2026-01-10',
      summary: 'Processo A',
      description: 'Descrição dos factos do processo A.',
    })
  )
  const loan = ok(
    await as(client, s).post(`/api/v1/hr/employees/${employee.id}/loans`, {
      kind: 'ADVANCE',
      currency: 'AOA',
      principal: '1000',
      installmentsCount: 1,
      firstPeriod: '2030-01',
      reason: 'Adiantamento A',
    })
  )
  const leaveRequest = ok(
    await as(client, s).post('/api/v1/hr/leave/requests', {
      employeeId: employee.id,
      leaveTypeId: leaveType.id,
      startDate: '2026-02-02',
      endDate: '2026-02-03',
    })
  )
  const contract = ok(
    await as(client, s).post(`/api/v1/hr/employees/${employee.id}/contracts`, {
      code: 'CT-A',
      contractType: 'PERMANENT',
      startDate: '2026-01-05',
      weeklyHours: '40',
      currency: 'AOA',
      baseSalary: '200000',
    })
  )
  const leaver = ok(
    await as(client, s).post('/api/v1/hr/employees', {
      code: 'COL-A2',
      fullName: 'Colaborador A2',
      legalEntityId: le.id,
      hireDate: '2026-01-05',
    })
  )
  const leaverContract = ok(
    await as(client, s).post(`/api/v1/hr/employees/${leaver.id}/contracts`, {
      code: 'CT-A2',
      contractType: 'PERMANENT',
      startDate: '2026-01-05',
      weeklyHours: '40',
      currency: 'AOA',
      baseSalary: '200000',
    })
  )
  ok(
    await as(client, s).post(`/api/v1/hr/contracts/${leaverContract.id}/activate`, {
      expectedVersion: leaverContract.version,
    }),
    200
  )
  const termination = ok(
    await as(client, s).post(`/api/v1/hr/employees/${leaver.id}/terminations`, {
      reason: 'RESIGNATION',
      details: 'Denúncia do contrato pelo colaborador A2.',
      lastWorkingDay: '2026-12-31',
      indemnityApplicable: false,
    })
  )
  const uom = ok(
    await as(client, s).post('/api/v1/inventory/settings/uoms', {
      code: 'UNA',
      name: 'Unidade A',
      category: 'UNIT',
    })
  )
  const productCategory = ok(
    await as(client, s).post('/api/v1/inventory/settings/categories', {
      code: 'CATA',
      name: 'Categoria A',
    })
  )
  const brand = ok(
    await as(client, s).post('/api/v1/inventory/settings/brands', {
      code: 'MARCA',
      name: 'Marca A',
    })
  )
  const product = ok(
    await as(client, s).post('/api/v1/inventory/products', {
      sku: 'SKU-A',
      barcode: 'INT-A-001',
      name: 'Produto A',
      productType: 'STOCKABLE',
      baseUomId: uom.id,
    })
  )
  const withVariant = ok(
    await as(client, s).post(`/api/v1/inventory/products/${product.id}/variants`, {
      sku: 'SKU-A-V',
      attributes: { Cor: 'Azul' },
    })
  )
  const variant = withVariant.variants[0]
  const warehouse = ok(
    await as(client, s).post('/api/v1/inventory/warehouses', {
      code: 'ARM-A',
      name: 'Armazém A',
      legalEntityId: le.id,
      warehouseType: 'MAIN',
    })
  )
  const withLocation = ok(
    await as(client, s).post(`/api/v1/inventory/warehouses/${warehouse.id}/locations`, {
      code: 'ZA',
    })
  )
  const location = withLocation.locations[0]
  const ctxA = (await as(client, s).get('/api/v1/context')).body().data
  const stock = await runInTenant(
    { tenantId: tenant.id, userId: admin.id, membershipId: ctxA.membershipId, requestId: 'matriz' },
    (scope) =>
      postStock(scope, {
        type: 'RECEIPT',
        idempotencyKey: 'matriz-stock-1',
        sourceType: 'TEST',
        lines: [
          {
            warehouseId: warehouse.id,
            productId: product.id,
            variantId: variant.id,
            bucket: 'UNRESTRICTED',
            quantity: '3',
          },
        ],
      })
  )
  const stockPosting = stock.posting
  // Lote e série (8.8).
  const lotted = ok(
    await as(client, s).post('/api/v1/inventory/products', {
      sku: 'LOTE-A',
      name: 'Produto com lote A',
      productType: 'STOCKABLE',
      baseUomId: uom.id,
      trackLots: true,
      trackSerials: true,
    })
  )
  await runInTenant(
    { tenantId: tenant.id, userId: admin.id, membershipId: ctxA.membershipId, requestId: 'matriz' },
    (scope) =>
      postStock(scope, {
        type: 'RECEIPT',
        idempotencyKey: 'matriz-lote-1',
        sourceType: 'TEST',
        lines: [
          {
            warehouseId: warehouse.id,
            productId: lotted.id,
            bucket: 'UNRESTRICTED',
            quantity: '1',
            lotCode: 'LA-1',
            serials: ['SN-A-1'],
          },
        ],
      })
  )
  const stockLot = (await as(client, s).get(`/api/v1/inventory/lots?productId=${lotted.id}`)).body()
    .data[0]
  const stockSerial = (await as(client, s).get('/api/v1/inventory/serials?q=SN-A-1')).body().data[0]
  const warehouse2 = ok(
    await as(client, s).post('/api/v1/inventory/warehouses', {
      code: 'ARM-A2',
      name: 'Armazém A2',
      legalEntityId: le.id,
      warehouseType: 'STORE',
    })
  )
  const reqDept = ok(
    await as(client, s).post('/api/v1/organization/departments', {
      code: 'DREQ',
      name: 'Departamento requisitante',
      legalEntityId: le.id,
    })
  )
  const stockRequisition = ok(
    await as(client, s).post('/api/v1/inventory/requisitions', {
      warehouseId: warehouse.id,
      departmentId: reqDept.id,
      purpose: 'Consumo interno A',
      lines: [{ productId: product.id, variantId: variant.id, quantity: '1' }],
    })
  )
  const stockTransfer = ok(
    await as(client, s).post('/api/v1/inventory/transfers', {
      sourceWarehouseId: warehouse.id,
      destWarehouseId: warehouse2.id,
      lines: [{ productId: product.id, variantId: variant.id, quantity: '1' }],
    })
  )
  const stockDocument = ok(
    await as(client, s).post('/api/v1/inventory/documents', {
      docType: 'RECEIPT',
      warehouseId: warehouse.id,
      origin: 'PURCHASE',
      lines: [{ productId: product.id, variantId: variant.id, uomId: uom.id, quantity: '2' }],
    })
  )
  const stockCount = ok(
    await as(client, s).post('/api/v1/inventory/counts', {
      warehouseId: warehouse.id,
      description: 'Contagem A',
    })
  )
  const docType = ok(
    await as(client, s).post('/api/v1/procurement/settings/document-types', {
      code: 'CERT-A',
      name: 'Certidão A',
    })
  )
  const criterion = ok(
    await as(client, s).post('/api/v1/procurement/settings/criteria', {
      code: 'CRIT-A',
      name: 'Critério A',
    })
  )
  let supplier = ok(
    await as(client, s).post('/api/v1/procurement/suppliers', {
      supplierType: 'GOODS',
      currency: 'AOA',
      partner: {
        code: 'FORN-A',
        name: 'Fornecedor A',
        partnerType: 'ORGANIZATION',
        taxId: '5000099001',
        countryCode: 'AO',
      },
    })
  )
  supplier = ok(
    await as(client, s).post(`/api/v1/procurement/suppliers/${supplier.id}/contacts`, {
      name: 'Contacto A',
      email: 'a@forn.ao',
    })
  )
  supplier = ok(
    await as(client, s).post(`/api/v1/procurement/suppliers/${supplier.id}/bank-accounts`, {
      holderName: 'Fornecedor A',
      bankName: 'Banco A',
      iban: 'AO84000600000123456789012',
    })
  )
  supplier = ok(
    await as(client, s).post(`/api/v1/procurement/suppliers/${supplier.id}/documents`, {
      documentTypeId: docType.id,
      number: 'DOC-A',
    })
  )
  ok(
    await as(client, s).post('/api/v1/document-series', {
      legalEntityId: le.id,
      documentType: 'PURCHASE_REQUISITION',
      code: 'RCA',
      prefix: 'RCA-',
    })
  )
  const approvalLevel = ok(
    await as(client, s).post('/api/v1/procurement/approval-levels', {
      code: 'NIVEL-A',
      name: 'Nível A',
      sequence: 1,
      minAmount: '0',
    })
  )
  const purchaseRequisition = ok(
    await as(client, s).post('/api/v1/procurement/requisitions', {
      departmentId: reqDept.id,
      neededBy: '2026-12-31',
      purpose: 'Compra A',
      lines: [{ description: 'Papel A4', quantity: '10', estimatedUnitPrice: '5' }],
    })
  )
  const rfq = ok(
    await as(client, s).post('/api/v1/procurement/rfqs', {
      legalEntityId: le.id,
      title: 'Cotação A',
      closesAt: new Date(Date.now() + 7 * 86_400_000).toISOString(),
      lines: [{ description: 'Papel A4', quantity: '10' }],
    })
  )
  // Adjudicação da empresa A inserida directamente (a API exige propostas abertas; aqui só interessa o isolamento).
  const rfqAward = (
    await db.connection('owner').rawQuery(
      `insert into rfq_awards (tenant_id, rfq_id, price_weight, delivery_weight, quality_weight, payment_weight,
          base_currency, rate_date, justification) values (?, ?, 100, 0, 0, 0, 'AOA', current_date, 'Isolamento')
       returning id`,
      [tenant.id, rfq.id]
    )
  ).rows[0] as { id: string }
  // Ordem de compra da empresa A inserida directamente (o fornecedor A não está homologado; só interessa o isolamento).
  const purchaseOrder = (
    await db.connection('owner').rawQuery(
      `insert into purchase_orders (tenant_id, legal_entity_id, supplier_id, currency, order_date)
       values (?, ?, ?, 'AOA', current_date) returning id`,
      [tenant.id, le.id, supplier.id]
    )
  ).rows[0] as { id: string }
  // Contrato e adenda da empresa A inseridos directamente (só interessa o isolamento).
  const purchaseContract = (
    await db.connection('owner').rawQuery(
      `insert into purchase_contracts (tenant_id, legal_entity_id, supplier_id, title, object, currency, start_date,
          end_date, max_amount) values (?, ?, ?, 'Contrato A', 'Objecto A', 'AOA', current_date, current_date + 30, 1000)
       returning id`,
      [tenant.id, le.id, supplier.id]
    )
  ).rows[0] as { id: string }
  const contractAmendment = (
    await db.connection('owner').rawQuery(
      `insert into purchase_contract_amendments (tenant_id, contract_id, amendment_no, kind, reason, effective_date,
          proposed, requested_by) values (?, ?, 1, 'CHANGE', 'Isolamento', current_date, '{}', ?) returning id`,
      [tenant.id, purchaseContract.id, admin.id]
    )
  ).rows[0] as { id: string }
  // Recepção da empresa A inserida directamente (só interessa o isolamento).
  const purchaseReceipt = (
    await db.connection('owner').rawQuery(
      `insert into purchase_receipts (tenant_id, legal_entity_id, order_id, supplier_id, receipt_date)
       values (?, ?, ?, ?, current_date) returning id`,
      [tenant.id, le.id, purchaseOrder.id, supplier.id]
    )
  ).rows[0] as { id: string }
  // Factura da empresa A inserida directamente (só interessa o isolamento).
  const purchaseInvoice = (
    await db.connection('owner').rawQuery(
      `insert into purchase_invoices (tenant_id, legal_entity_id, supplier_id, order_id, invoice_number, invoice_number_key,
          invoice_date, due_date, currency, declared_total) values (?, ?, ?, ?, 'FA-1', 'FA-1', current_date, current_date,
          'AOA', 0) returning id`,
      [tenant.id, le.id, supplier.id, purchaseOrder.id]
    )
  ).rows[0] as { id: string }
  // Devolução e nota de crédito da empresa A inseridas directamente (só interessa o isolamento).
  const purchaseReturn = (
    await db.connection('owner').rawQuery(
      `insert into purchase_returns (tenant_id, legal_entity_id, receipt_id, order_id, supplier_id, return_date,
          reason_code, description, remedy) values (?, ?, ?, ?, ?, current_date, 'QUALITY', 'Isolamento', 'CREDIT')
       returning id`,
      [tenant.id, le.id, purchaseReceipt.id, purchaseOrder.id, supplier.id]
    )
  ).rows[0] as { id: string }
  const purchaseCreditNote = (
    await db.connection('owner').rawQuery(
      `insert into purchase_credit_notes (tenant_id, legal_entity_id, supplier_id, order_id, invoice_id,
          credit_note_number, credit_note_number_key, credit_note_date, currency, reason, declared_total, exchange_rate)
       values (?, ?, ?, ?, ?, 'NC-1', 'NC-1', current_date, 'AOA', 'Isolamento', 1, 1) returning id`,
      [tenant.id, le.id, supplier.id, purchaseOrder.id, purchaseInvoice.id]
    )
  ).rows[0] as { id: string }
  // Centro de custo, verba e obrigação a pagar da empresa A inseridos directamente (só interessa o isolamento).
  const costCenter = (
    await db.connection('owner').rawQuery(
      `insert into cost_centers (tenant_id, legal_entity_id, code, name) values (?, ?, 'CC-ISO', 'Centro isolado')
       returning id`,
      [tenant.id, le.id]
    )
  ).rows[0] as { id: string }
  const procurementBudget = (
    await db.connection('owner').rawQuery(
      `insert into procurement_budgets (tenant_id, legal_entity_id, cost_center_id, fiscal_year, amount)
       values (?, ?, ?, 2026, 1000) returning id`,
      [tenant.id, le.id, costCenter.id]
    )
  ).rows[0] as { id: string }
  const procurementPayable = (
    await db.connection('owner').rawQuery(
      `insert into procurement_payables (tenant_id, legal_entity_id, supplier_id, order_id, invoice_id, currency, amount,
          exchange_rate, due_date) values (?, ?, ?, ?, ?, 'AOA', 100, 1, current_date) returning id`,
      [tenant.id, le.id, supplier.id, purchaseOrder.id, purchaseInvoice.id]
    )
  ).rows[0] as { id: string }
  // Avaliação publicada da empresa A inserida directamente (só interessa o isolamento).
  const supplierEvaluation = (
    await db.connection('owner').rawQuery(
      `insert into supplier_evaluations (tenant_id, supplier_id, period_from, period_to, weights, indicators, score, rating)
       values (?, ?, '2026-01-01', '2026-06-30', '{}', '{}', 80, 'B') returning id`,
      [tenant.id, supplier.id]
    )
  ).rows[0] as { id: string }
  // Cliente da empresa A (o terceiro do fornecedor A também é cliente) e segmento, inseridos directamente.
  const customerSegment = (
    await db
      .connection('owner')
      .rawQuery(
        `insert into customer_segments (tenant_id, code, name) values (?, 'SEG-A', 'Segmento A') returning id`,
        [tenant.id]
      )
  ).rows[0] as { id: string }
  const customer = (
    await db
      .connection('owner')
      .rawQuery(
        `insert into customers (tenant_id, partner_id, currency) values (?, ?, 'AOA') returning id`,
        [tenant.id, supplier.partner.id]
      )
  ).rows[0] as { id: string }
  const customerAddress = (
    await db.connection('owner').rawQuery(
      `insert into customer_addresses (tenant_id, customer_id, kind, label, address_line, country_code)
       values (?, ?, 'BILLING', 'Sede', 'Rua A', 'AO') returning id`,
      [tenant.id, customer.id]
    )
  ).rows[0] as { id: string }
  // Preços da empresa A (10.2): tabela em rascunho com uma linha, regra e limite de desconto, inseridos directamente.
  const owner = db.connection('owner')
  const priceList = (
    await owner.rawQuery(
      `insert into price_lists (tenant_id, code, name, currency, target_type, valid_from)
       values (?, 'PL-A', 'Tabela A', 'AOA', 'GENERAL', '2026-01-01') returning id`,
      [tenant.id]
    )
  ).rows[0] as { id: string }
  const priceListLine = (
    await owner.rawQuery(
      `insert into price_list_lines (tenant_id, price_list_id, product_id, unit_price) values (?, ?, ?, 10) returning id`,
      [tenant.id, priceList.id, product.id]
    )
  ).rows[0] as { id: string }
  const discountRule = (
    await owner.rawQuery(
      `insert into discount_rules (tenant_id, code, name, target_type, discount_pct, valid_from)
       values (?, 'DR-A', 'Regra A', 'ALL', 5, '2026-01-01') returning id`,
      [tenant.id]
    )
  ).rows[0] as { id: string }
  const discountLimit = (
    await owner.rawQuery(
      `insert into discount_limits (tenant_id, target_type, max_pct) values (?, 'GENERAL', 5) returning id`,
      [tenant.id]
    )
  ).rows[0] as { id: string }
  // Orçamento da empresa A (10.3), em rascunho com uma linha, inserido directamente.
  const salesQuote = (
    await owner.rawQuery(
      `insert into sales_quotes (tenant_id, legal_entity_id, customer_id, salesperson_membership_id, quote_date,
         valid_until, currency) values (?, ?, ?, (select id from tenant_memberships where tenant_id = ? limit 1),
         '2026-06-01', '2026-06-30', 'AOA') returning id`,
      [tenant.id, le.id, customer.id, tenant.id]
    )
  ).rows[0] as { id: string }
  await owner.rawQuery(
    `insert into sales_quote_lines (tenant_id, quote_id, line_no, product_id, description, quantity, tax_rate,
       price_source, pricing) values (?, ?, 1, ?, 'Linha A', 1, 14, 'CATALOG', '{}')`,
    [tenant.id, salesQuote.id, product.id]
  )
  // Encomenda de venda da empresa A (10.4), em rascunho com uma linha, inserida directamente.
  const salesOrder = (
    await owner.rawQuery(
      `insert into sales_orders (tenant_id, legal_entity_id, customer_id, salesperson_membership_id, order_date, currency)
       values (?, ?, ?, (select id from tenant_memberships where tenant_id = ? limit 1), '2026-06-01', 'AOA') returning id`,
      [tenant.id, le.id, customer.id, tenant.id]
    )
  ).rows[0] as { id: string }
  const salesOrderLine = (
    await owner.rawQuery(
      `insert into sales_order_lines (tenant_id, order_id, line_no, product_id, description, is_stock, quantity, tax_rate,
         price_source, pricing) values (?, ?, 1, ?, 'Linha A', true, 1, 14, 'CATALOG', '{}') returning id`,
      [tenant.id, salesOrder.id, product.id]
    )
  ).rows[0] as { id: string }
  // Configuração fiscal da empresa A (10.5): imposto com taxa em rascunho, isenção e série, inseridos directamente.
  const taxCode = (
    await owner.rawQuery(
      `insert into tax_codes (tenant_id, country_code, code, name, kind, tax_type) values (?, 'AO', 'TA', 'Teste A', 'TAX', 'VAT') returning id`,
      [tenant.id]
    )
  ).rows[0] as { id: string }
  const taxRate = (
    await owner.rawQuery(
      `insert into tax_rates (tenant_id, tax_code_id, valid_from, rate, legal_source) values (?, ?, '2026-01-01', 10, 'Fonte de teste') returning id`,
      [tenant.id, taxCode.id]
    )
  ).rows[0] as { id: string }
  const taxExemption = (
    await owner.rawQuery(
      `insert into tax_exemptions (tenant_id, country_code, code, description, legal_source) values (?, 'AO', 'XA', 'Isenção A', 'Fonte de teste') returning id`,
      [tenant.id]
    )
  ).rows[0] as { id: string }
  const fiscalSeries = (
    await owner.rawQuery(
      `insert into fiscal_series (tenant_id, legal_entity_id, document_kind, fiscal_code, code, fiscal_year, prefix)
       values (?, ?, 'INVOICE', 'FT', 'SA', 2026, 'FT SA/') returning id`,
      [tenant.id, le.id]
    )
  ).rows[0] as { id: string }
  // Factura de venda da empresa A (10.6), em rascunho, inserida directamente.
  const salesInvoice = (
    await owner.rawQuery(
      `insert into sales_invoices (tenant_id, legal_entity_id, customer_id, invoice_date, currency) values (?, ?, ?, '2026-06-01', 'AOA') returning id`,
      [tenant.id, le.id, customer.id]
    )
  ).rows[0] as { id: string }
  // Recebimento pendente da empresa A (10.7), inserido directamente.
  const salesReceipt = (
    await owner.rawQuery(
      `insert into sales_receipts (tenant_id, legal_entity_id, customer_id, purpose, currency, amount, method, received_date,
         request_key, request_hash) values (?, ?, ?, 'RECEIPT', 'AOA', 100, 'CASH', '2026-06-01', 'isolamento-a', 'x') returning id`,
      [tenant.id, le.id, customer.id]
    )
  ).rows[0] as { id: string }
  // Nota de crédito em rascunho da empresa A (10.8) sobre a factura, inserida directamente.
  const customerVersion = (
    await owner.rawQuery(
      `insert into customer_versions (tenant_id, customer_id, version_no, data, hash) values (?, ?, 1, '{}', 'x') returning id`,
      [tenant.id, customer.id]
    )
  ).rows[0] as { id: string }
  const salesNote = (
    await owner.rawQuery(
      `insert into sales_notes (tenant_id, kind, invoice_id, legal_entity_id, customer_id, reason_code, reason, note_date,
         currency, functional_currency, exchange_rate, customer_version_id, customer_snapshot, rounding_level)
       values (?, 'CREDIT', ?, ?, ?, 'OTHER', 'Teste A', '2026-06-01', 'AOA', 'AOA', 1, ?, '{}', 'LINE') returning id`,
      [tenant.id, salesInvoice.id, le.id, customer.id, customerVersion.id]
    )
  ).rows[0] as { id: string }
  // Submissão fiscal da empresa A (10.9), falhada, inserida directamente.
  const fiscalSubmission = (
    await owner.rawQuery(
      `insert into fiscal_submissions (tenant_id, legal_entity_id, document_type, document_id, document_number, provider,
         payload_format, payload, payload_hash, idempotency_key, status, requested_membership_id)
       values (?, ?, 'SALES_INVOICE', ?, 'FT SA/1', 'LOCAL_SIMULATOR', 'SG-SIM-1', '{}', 'x', 'isolamento-a', 'FAILED',
               (select id from tenant_memberships where tenant_id = ? limit 1)) returning id`,
      [tenant.id, le.id, salesInvoice.id, tenant.id]
    )
  ).rows[0] as { id: string }
  // Promessa de pagamento da empresa A (10.10), inserida directamente.
  const collectionPromise = (
    await owner.rawQuery(
      `insert into collection_promises (tenant_id, legal_entity_id, customer_id, currency, amount, promised_date)
       values (?, ?, ?, 'AOA', 100, '2099-01-01') returning id`,
      [tenant.id, le.id, customer.id]
    )
  ).rows[0] as { id: string }
  const audit = (await as(client, s).get('/api/v1/audit-events?limit=1')).body().data[0]
  return {
    collectionPromise,
    fiscalSubmission,
    salesNote,
    salesReceipt,
    salesInvoice,
    taxCode,
    taxRate,
    taxExemption,
    fiscalSeries,
    salesOrder,
    salesOrderLine,
    salesQuote,
    priceList,
    priceListLine,
    discountRule,
    discountLimit,
    customerSegment,
    customer,
    customerAddress,
    supplierEvaluation,
    costCenter,
    procurementBudget,
    procurementPayable,
    purchaseReturn,
    purchaseCreditNote,
    purchaseInvoice,
    purchaseReceipt,
    purchaseContract,
    contractAmendment,
    purchaseOrder,
    rfq,
    rfqAward,
    purchaseRequisition,
    approvalLevel,
    supplier,
    supplierDocType: docType,
    supplierCriterion: criterion,
    stockLot,
    stockSerial,
    stockCount,
    stockRequisition,
    stockTransfer,
    stockDocument,
    stockPosting,
    warehouse,
    location,
    uom,
    productCategory,
    brand,
    product,
    variant,
    leaver,
    termination,
    employee,
    requisition,
    candidate,
    application,
    interview,
    offer,
    onboardingTask,
    contract,
    leavePolicy,
    leaveType,
    leaveRequest,
    payComponent,
    compProposal,
    loan,
    competency,
    course,
    trainingSession,
    certificate,
    disciplinaryCase,
    ruleSet,
    payrollRun,
    closeTask,
    stmtTemplate,
    stmtNote,
    schedule,
    provision,
    assetClass,
    asset,
    dimension,
    dimValue,
    allocKey,
    rule,
    postingEvent,
    chart,
    accountA,
    fy,
    period,
    journal,
    entry,
    rate,
    series,
    calendar,
    holiday,
    bank,
    tenantId: tenant.id,
    le,
    branch,
    role,
    member: approver.memberId,
    wf,
    request,
    delegation,
    attachment,
    notification,
    audit,
  }
}

test.group('isolamento | matriz entre empresas', (group) => {
  group.each.setup(() => cleanDatabase())

  test('o administrador de outra empresa (todas as permissões) não lê, altera nem refere registos de A', async ({
    client,
    assert,
  }) => {
    const a = await populate(client)
    const { tenant, admin } = await tenantWithAdmin()
    const b = await signIn(client, admin.email, tenant.id)
    const B = as(client, b)
    const v = { expectedVersion: 1 }

    const attempts: [string, Promise<any>][] = [
      ['GET entidade', B.get(`/api/v1/organization/legal-entities/${a.le.id}`)],
      [
        'PATCH entidade',
        B.patch(`/api/v1/organization/legal-entities/${a.le.id}`, { ...v, tradeName: 'x' }),
      ],
      ['GET filial', B.get(`/api/v1/organization/branches/${a.branch.id}`)],
      ['GET perfil', B.get(`/api/v1/roles/${a.role.id}`)],
      ['PATCH perfil', B.patch(`/api/v1/roles/${a.role.id}`, { ...v, name: 'x' })],
      ['DELETE perfil', B.delete(`/api/v1/roles/${a.role.id}`)],
      ['GET membro', B.get(`/api/v1/members/${a.member}`)],
      ['GET colaborador', B.get(`/api/v1/hr/employees/${a.employee.id}`)],
      [
        'PATCH colaborador',
        B.patch(`/api/v1/hr/employees/${a.employee.id}`, { ...v, fullName: 'xx' }),
      ],
      [
        'suspender colaborador',
        B.post(`/api/v1/hr/employees/${a.employee.id}/status`, { ...v, status: 'SUSPENDED' }),
      ],
      ['GET vaga', B.get(`/api/v1/hr/requisitions/${a.requisition.id}`)],
      ['PATCH vaga', B.patch(`/api/v1/hr/requisitions/${a.requisition.id}`, { ...v, title: 'xx' })],
      ['submeter vaga', B.post(`/api/v1/hr/requisitions/${a.requisition.id}/submit`, v)],
      [
        'decidir vaga',
        B.post(`/api/v1/hr/requisitions/${a.requisition.id}/decision`, {
          ...v,
          decision: 'APPROVE',
        }),
      ],
      ['fechar vaga', B.post(`/api/v1/hr/requisitions/${a.requisition.id}/close`, v)],
      ['cancelar vaga', B.post(`/api/v1/hr/requisitions/${a.requisition.id}/cancel`, v)],
      ['GET candidato', B.get(`/api/v1/hr/candidates/${a.candidate.id}`)],
      ['PATCH candidato', B.patch(`/api/v1/hr/candidates/${a.candidate.id}`, { ...v, notes: 'x' })],
      ['GET candidatura', B.get(`/api/v1/hr/applications/${a.application.id}`)],
      [
        'etapa da candidatura',
        B.post(`/api/v1/hr/applications/${a.application.id}/stage`, {
          ...v,
          stage: 'REJECTED',
          reason: 'x',
        }),
      ],
      [
        'marcar entrevista',
        B.post(`/api/v1/hr/applications/${a.application.id}/interviews`, {
          scheduledAt: '2030-01-11T10:00:00Z',
          mode: 'PHONE',
          interviewerMembershipId: a.member,
        }),
      ],
      [
        'PATCH entrevista',
        B.patch(`/api/v1/hr/interviews/${a.interview.id}`, { ...v, status: 'DONE' }),
      ],
      [
        'avaliar candidatura',
        B.post(`/api/v1/hr/applications/${a.application.id}/evaluations`, {
          score: 3,
          recommendation: 'HOLD',
        }),
      ],
      [
        'nova proposta',
        B.post(`/api/v1/hr/applications/${a.application.id}/offers`, {
          salary: '150000',
          startDate: '2030-02-01',
        }),
      ],
      ['PATCH proposta', B.patch(`/api/v1/hr/offers/${a.offer.id}`, { ...v, salary: '160000' })],
      ['submeter proposta', B.post(`/api/v1/hr/offers/${a.offer.id}/submit`, v)],
      [
        'decidir proposta',
        B.post(`/api/v1/hr/offers/${a.offer.id}/decision`, { ...v, decision: 'APPROVE' }),
      ],
      [
        'responder proposta',
        B.post(`/api/v1/hr/offers/${a.offer.id}/response`, { ...v, accepted: true }),
      ],
      ['cancelar proposta', B.post(`/api/v1/hr/offers/${a.offer.id}/cancel`, v)],
      ['contratar', B.post(`/api/v1/hr/offers/${a.offer.id}/hire`, { ...v, code: 'X1' })],
      ['GET contratos', B.get(`/api/v1/hr/employees/${a.employee.id}/contracts`)],
      [
        'novo contrato',
        B.post(`/api/v1/hr/employees/${a.employee.id}/contracts`, {
          code: 'X',
          contractType: 'PERMANENT',
          startDate: '2026-02-01',
          weeklyHours: '40',
          currency: 'AOA',
          baseSalary: '1',
        }),
      ],
      ['GET contrato', B.get(`/api/v1/hr/contracts/${a.contract.id}`)],
      ['PATCH contrato', B.patch(`/api/v1/hr/contracts/${a.contract.id}`, { ...v, notes: 'x' })],
      ['activar contrato', B.post(`/api/v1/hr/contracts/${a.contract.id}/activate`, v)],
      ['cancelar contrato', B.post(`/api/v1/hr/contracts/${a.contract.id}/cancel`, v)],
      [
        'terminar contrato',
        B.post(`/api/v1/hr/contracts/${a.contract.id}/terminate`, {
          ...v,
          date: '2026-03-01',
          reason: 'x',
        }),
      ],
      [
        'adenda',
        B.post(`/api/v1/hr/contracts/${a.contract.id}/amendments`, {
          ...v,
          kind: 'CHANGE',
          effectiveDate: '2026-03-01',
          baseSalary: '1',
          reason: 'xxx',
        }),
      ],
      ['GET política de férias', B.get(`/api/v1/hr/leave/policies/${a.leavePolicy.id}`)],
      [
        'PATCH política de férias',
        B.patch(`/api/v1/hr/leave/policies/${a.leavePolicy.id}`, { ...v, name: 'xxxx' }),
      ],
      ['publicar política', B.post(`/api/v1/hr/leave/policies/${a.leavePolicy.id}/publish`, v)],
      [
        'PATCH tipo de ausência',
        B.patch(`/api/v1/hr/leave/types/${a.leaveType.id}`, { ...v, name: 'xx' }),
      ],
      ['GET pedido de ausência', B.get(`/api/v1/hr/leave/requests/${a.leaveRequest.id}`)],
      [
        'decidir ausência',
        B.post(`/api/v1/hr/leave/requests/${a.leaveRequest.id}/decision`, {
          ...v,
          decision: 'APPROVE',
        }),
      ],
      ['cancelar ausência', B.post(`/api/v1/hr/leave/requests/${a.leaveRequest.id}/cancel`, v)],
      ['GET saldo de férias', B.get(`/api/v1/hr/employees/${a.employee.id}/leave`)],
      [
        'ajustar saldo',
        B.post(`/api/v1/hr/employees/${a.employee.id}/leave/adjustments`, {
          year: 2026,
          days: '1',
          reason: 'xxx',
        }),
      ],
      [
        'pedir ausência para colaborador de A',
        B.post('/api/v1/hr/leave/requests', {
          employeeId: a.employee.id,
          leaveTypeId: a.leaveType.id,
          startDate: '2026-03-02',
          endDate: '2026-03-03',
        }),
      ],
      [
        'pré-visualizar ausência de A',
        B.post('/api/v1/hr/leave/requests/preview', {
          employeeId: a.employee.id,
          leaveTypeId: a.leaveType.id,
          startDate: '2026-03-02',
          endDate: '2026-03-03',
        }),
      ],
      ['GET componente', B.get(`/api/v1/hr/pay-components/${a.payComponent.id}`)],
      [
        'PATCH componente',
        B.patch(`/api/v1/hr/pay-components/${a.payComponent.id}`, { ...v, name: 'xx' }),
      ],
      [
        'incidência de componente',
        B.post(`/api/v1/hr/pay-components/${a.payComponent.id}/incidences`, {
          validFrom: '2026-01-01',
          irtSubject: true,
          inssSubject: true,
          legalReference: 'xxxxx',
        }),
      ],
      ['GET remuneração', B.get(`/api/v1/hr/employees/${a.employee.id}/compensation`)],
      [
        'nova proposta de compensação',
        B.post(`/api/v1/hr/employees/${a.employee.id}/compensation/proposals`, {
          effectiveDate: '2026-03-01',
          reason: 'xxx',
          lines: [{ componentId: a.payComponent.id, action: 'SET', amount: '1' }],
        }),
      ],
      ['GET proposta', B.get(`/api/v1/hr/compensation/proposals/${a.compProposal.id}`)],
      [
        'PATCH proposta',
        B.patch(`/api/v1/hr/compensation/proposals/${a.compProposal.id}`, { ...v, reason: 'xxx' }),
      ],
      [
        'submeter proposta',
        B.post(`/api/v1/hr/compensation/proposals/${a.compProposal.id}/submit`, v),
      ],
      [
        'decidir proposta',
        B.post(`/api/v1/hr/compensation/proposals/${a.compProposal.id}/decision`, {
          ...v,
          decision: 'APPROVE',
        }),
      ],
      [
        'cancelar proposta',
        B.post(`/api/v1/hr/compensation/proposals/${a.compProposal.id}/cancel`, v),
      ],
      ['GET empréstimos do colaborador', B.get(`/api/v1/hr/employees/${a.employee.id}/loans`)],
      [
        'novo empréstimo',
        B.post(`/api/v1/hr/employees/${a.employee.id}/loans`, {
          kind: 'ADVANCE',
          currency: 'AOA',
          principal: '1',
          installmentsCount: 1,
          firstPeriod: '2030-01',
          reason: 'xxx',
        }),
      ],
      ['GET empréstimo', B.get(`/api/v1/hr/loans/${a.loan.id}`)],
      ['PATCH empréstimo', B.patch(`/api/v1/hr/loans/${a.loan.id}`, { ...v, reason: 'xxx' })],
      ['submeter empréstimo', B.post(`/api/v1/hr/loans/${a.loan.id}/submit`, v)],
      [
        'decidir empréstimo',
        B.post(`/api/v1/hr/loans/${a.loan.id}/decision`, { ...v, decision: 'APPROVE' }),
      ],
      ['cancelar empréstimo', B.post(`/api/v1/hr/loans/${a.loan.id}/cancel`, v)],
      [
        'pagar prestação',
        B.post(`/api/v1/hr/loans/${a.loan.id}/installments/${a.loan.id}/payment`, {
          ...v,
          reference: 'X',
          paidOn: '2026-01-01',
        }),
      ],
      ['GET regras de processamento', B.get(`/api/v1/hr/payroll/rule-sets/${a.ruleSet.id}`)],
      [
        'PATCH regras',
        B.patch(`/api/v1/hr/payroll/rule-sets/${a.ruleSet.id}`, { ...v, name: 'xxx' }),
      ],
      ['publicar regras', B.post(`/api/v1/hr/payroll/rule-sets/${a.ruleSet.id}/publish`, v)],
      ['verificar casos', B.post(`/api/v1/hr/payroll/rule-sets/${a.ruleSet.id}/verify`)],
      [
        'simular regras',
        B.post(`/api/v1/hr/payroll/rule-sets/${a.ruleSet.id}/simulate`, { baseSalary: '1' }),
      ],
      [
        'confirmar regras',
        B.post(`/api/v1/hr/payroll/rule-sets/${a.ruleSet.id}/confirm`, { ...v, note: 'xxxxxx' }),
      ],
      ['GET lote', B.get(`/api/v1/hr/payroll/runs/${a.payrollRun.id}`)],
      ['GET pagamentos do lote', B.get(`/api/v1/hr/payroll/runs/${a.payrollRun.id}/payments`)],
      [
        'pagar obrigação',
        B.post(`/api/v1/hr/payroll/obligations/${a.payrollRun.id}/payments`, {
          ...v,
          amount: '1',
          paidOn: '2026-01-01',
          reference: 'X',
        }),
      ],
      ['contabilizar lote', B.post(`/api/v1/hr/payroll/runs/${a.payrollRun.id}/accounting`)],
      ['GET recibo PDF', B.get(`/api/v1/hr/payslips/${a.payrollRun.id}`)],
      [
        'GET recibo',
        B.get(`/api/v1/hr/payroll/runs/${a.payrollRun.id}/results/${a.payrollRun.id}`),
      ],
      [
        'valor variável',
        B.put(`/api/v1/hr/payroll/runs/${a.payrollRun.id}/inputs`, {
          ...v,
          employeeId: a.employee.id,
          componentId: a.payComponent.id,
          amount: '1',
        }),
      ],
      [
        'excluir do lote',
        B.post(`/api/v1/hr/payroll/runs/${a.payrollRun.id}/exclusions`, {
          ...v,
          employeeId: a.employee.id,
          excluded: true,
        }),
      ],
      ['calcular lote', B.post(`/api/v1/hr/payroll/runs/${a.payrollRun.id}/calculate`, v)],
      ['submeter lote', B.post(`/api/v1/hr/payroll/runs/${a.payrollRun.id}/submit`, v)],
      [
        'decidir lote',
        B.post(`/api/v1/hr/payroll/runs/${a.payrollRun.id}/decision`, {
          ...v,
          decision: 'APPROVE',
        }),
      ],
      ['fechar lote', B.post(`/api/v1/hr/payroll/runs/${a.payrollRun.id}/close`, v)],
      ['cancelar lote', B.post(`/api/v1/hr/payroll/runs/${a.payrollRun.id}/cancel`, v)],
      [
        'meses de outra empresa',
        B.get(`/api/v1/hr/payroll/periods?legalEntityId=${a.employee.legalEntityId}`),
      ],
      [
        'PATCH competência',
        B.patch(`/api/v1/hr/training/competencies/${a.competency.id}`, { name: 'xxx' }),
      ],
      ['PATCH curso', B.patch(`/api/v1/hr/training/courses/${a.course.id}`, { name: 'xxx' })],
      ['GET sessão de formação', B.get(`/api/v1/hr/training/sessions/${a.trainingSession.id}`)],
      [
        'inscrever na sessão',
        B.post(`/api/v1/hr/training/sessions/${a.trainingSession.id}/enrollments`, {
          ...v,
          employeeIds: [a.employee.id],
        }),
      ],
      [
        'concluir sessão',
        B.post(`/api/v1/hr/training/sessions/${a.trainingSession.id}/complete`, v),
      ],
      ['cancelar sessão', B.post(`/api/v1/hr/training/sessions/${a.trainingSession.id}/cancel`, v)],
      [
        'resultado de inscrição',
        B.post(`/api/v1/hr/training/enrollments/${a.trainingSession.id}/result`, {
          ...v,
          status: 'PASSED',
        }),
      ],
      ['GET formação do colaborador', B.get(`/api/v1/hr/employees/${a.employee.id}/training`)],
      [
        'avaliar competência',
        B.post(`/api/v1/hr/employees/${a.employee.id}/competencies`, {
          competencyId: a.competency.id,
          level: 1,
          acquiredOn: '2026-01-01',
        }),
      ],
      [
        'certificado noutra empresa',
        B.post(`/api/v1/hr/employees/${a.employee.id}/certificates`, {
          name: 'X',
          issuer: 'Y',
          issuedOn: '2026-01-01',
        }),
      ],
      ['GET processo disciplinar', B.get(`/api/v1/hr/discipline/cases/${a.disciplinaryCase.id}`)],
      [
        'abrir processo',
        B.post(`/api/v1/hr/employees/${a.employee.id}/discipline/cases`, {
          category: 'OTHER',
          occurredOn: '2026-01-01',
          summary: 'xxx',
          description: 'xxxxxxxxxxxx',
        }),
      ],
      [
        'registo no processo',
        B.post(`/api/v1/hr/discipline/cases/${a.disciplinaryCase.id}/events`, {
          ...v,
          kind: 'NOTE',
          occurredOn: '2026-01-11',
          text: 'xxx',
        }),
      ],
      [
        'instruir processo',
        B.post(`/api/v1/hr/discipline/cases/${a.disciplinaryCase.id}/review`, v),
      ],
      [
        'encerrar processo',
        B.post(`/api/v1/hr/discipline/cases/${a.disciplinaryCase.id}/close`, {
          ...v,
          outcome: 'NO_ACTION',
          decidedOn: '2026-01-11',
          outcomeDetails: 'xxx',
        }),
      ],
      [
        'anexos do certificado',
        B.get(`/api/v1/attachments?subjectType=employee_certificate&subjectId=${a.certificate.id}`),
      ],
      [
        'anexos do processo',
        B.get(
          `/api/v1/attachments?subjectType=disciplinary_case&subjectId=${a.disciplinaryCase.id}`
        ),
      ],
      ['GET documento de stock', B.get(`/api/v1/inventory/documents/${a.stockDocument.id}`)],
      [
        'PUT documento de stock',
        B.put(`/api/v1/inventory/documents/${a.stockDocument.id}`, {
          ...v,
          origin: 'OTHER',
          lines: [],
        }),
      ],
      [
        'conferir documento alheio',
        B.post(`/api/v1/inventory/documents/${a.stockDocument.id}/check`, { ...v, lines: [] }),
      ],
      [
        'confirmar documento alheio',
        B.post(`/api/v1/inventory/documents/${a.stockDocument.id}/confirm`, {
          ...v,
          idempotencyKey: 'matriz-b-confirm',
        }),
      ],
      [
        'anular documento alheio',
        B.post(`/api/v1/inventory/documents/${a.stockDocument.id}/cancel`, { ...v, reason: 'x' }),
      ],
      [
        'GET valorização de produto alheio',
        B.get(`/api/v1/inventory/valuation/products/${a.product.id}?legalEntityId=${a.le.id}`),
      ],
      [
        'ajustar custo alheio',
        B.post('/api/v1/inventory/valuation/adjustments', {
          legalEntityId: a.le.id,
          productId: a.product.id,
          amount: '10',
          reason: 'x',
          idempotencyKey: 'matriz-ajuste-1',
        }),
      ],
      [
        'reconciliação de entidade alheia',
        B.get(`/api/v1/inventory/valuation/reconciliation?legalEntityId=${a.le.id}`),
      ],
      [
        'contas de valorização alheias',
        B.get(`/api/v1/inventory/valuation/accounts?legalEntityId=${a.le.id}`),
      ],
      [
        'integrar recepção no armazém alheio',
        B.post('/api/v1/inventory/integrations/purchase-receipts', {
          idempotencyKey: 'matriz-int-1',
          warehouseId: a.warehouse.id,
          orderRef: 'PO-X',
          documentRef: 'R-X',
          lines: [{ productId: a.product.id, quantity: '1', unitCost: '1' }],
        }),
      ],
      [
        'estado de encomenda no armazém alheio',
        B.get(
          `/api/v1/inventory/integrations/sales-orders?warehouseId=${a.warehouse.id}&orderRef=X`
        ),
      ],
      [
        'reposição no armazém alheio',
        B.get(`/api/v1/inventory/reports/replenishment?warehouseId=${a.warehouse.id}`),
      ],
      [
        'validades no armazém alheio',
        B.get(`/api/v1/inventory/reports/expiry?warehouseId=${a.warehouse.id}`),
      ],
      [
        'movimentos do armazém alheio',
        B.get(
          `/api/v1/inventory/reports/movements?warehouseId=${a.warehouse.id}&from=2026-01-01&to=2026-12-31`
        ),
      ],
      [
        'inventário valorizado da entidade alheia',
        B.get(`/api/v1/inventory/reports/valued?legalEntityId=${a.le.id}`),
      ],
      [
        'GET requisição de compra',
        B.get(`/api/v1/procurement/requisitions/${a.purchaseRequisition.id}`),
      ],
      [
        'alterar requisição de compra alheia',
        B.put(`/api/v1/procurement/requisitions/${a.purchaseRequisition.id}`, {
          ...v,
          departmentId: a.purchaseRequisition.department.id,
          lines: [],
        }),
      ],
      [
        'submeter requisição alheia',
        B.post(`/api/v1/procurement/requisitions/${a.purchaseRequisition.id}/submit`, v),
      ],
      [
        'aprovar requisição alheia',
        B.post(`/api/v1/procurement/requisitions/${a.purchaseRequisition.id}/approve`, v),
      ],
      [
        'recusar requisição alheia',
        B.post(`/api/v1/procurement/requisitions/${a.purchaseRequisition.id}/reject`, {
          ...v,
          reason: 'x',
        }),
      ],
      [
        'anular requisição alheia',
        B.post(`/api/v1/procurement/requisitions/${a.purchaseRequisition.id}/cancel`, {
          ...v,
          reason: 'x',
        }),
      ],
      [
        'fechar requisição alheia',
        B.post(`/api/v1/procurement/requisitions/${a.purchaseRequisition.id}/close`, {
          ...v,
          reason: 'x',
        }),
      ],
      [
        'copiar requisição alheia',
        B.post(`/api/v1/procurement/requisitions/${a.purchaseRequisition.id}/copy`),
      ],
      [
        'alterar etapa de aprovação alheia',
        B.patch(`/api/v1/procurement/approval-levels/${a.approvalLevel.id}`, {
          ...v,
          name: 'Outra',
        }),
      ],
      ['GET pedido de cotação', B.get(`/api/v1/procurement/rfqs/${a.rfq.id}`)],
      [
        'alterar pedido de cotação alheio',
        B.put(`/api/v1/procurement/rfqs/${a.rfq.id}`, { ...v, title: 'Outro', lines: [] }),
      ],
      [
        'convidar para pedido de cotação alheio',
        B.post(`/api/v1/procurement/rfqs/${a.rfq.id}/invitations`, { supplierIds: [] }),
      ],
      ['emitir pedido de cotação alheio', B.post(`/api/v1/procurement/rfqs/${a.rfq.id}/issue`, v)],
      [
        'rever pedido de cotação alheio',
        B.post(`/api/v1/procurement/rfqs/${a.rfq.id}/amend`, { ...v, reason: 'x' }),
      ],
      [
        'registar proposta em pedido alheio',
        B.post(`/api/v1/procurement/rfqs/${a.rfq.id}/quotes`, { supplierId: a.supplier.id }),
      ],
      ['abrir propostas de pedido alheio', B.post(`/api/v1/procurement/rfqs/${a.rfq.id}/open`, v)],
      [
        'anular pedido de cotação alheio',
        B.post(`/api/v1/procurement/rfqs/${a.rfq.id}/cancel`, { ...v, reason: 'x' }),
      ],
      ['mapa comparativo alheio', B.post(`/api/v1/procurement/rfqs/${a.rfq.id}/comparison`, {})],
      [
        'adjudicar pedido alheio',
        B.post(`/api/v1/procurement/rfqs/${a.rfq.id}/awards`, { justification: 'x', lines: [] }),
      ],
      ['GET adjudicação', B.get(`/api/v1/procurement/rfq-awards/${a.rfqAward.id}`)],
      [
        'alterar adjudicação alheia',
        B.put(`/api/v1/procurement/rfq-awards/${a.rfqAward.id}`, { ...v, lines: [] }),
      ],
      [
        'submeter adjudicação alheia',
        B.post(`/api/v1/procurement/rfq-awards/${a.rfqAward.id}/submit`, v),
      ],
      [
        'aprovar adjudicação alheia',
        B.post(`/api/v1/procurement/rfq-awards/${a.rfqAward.id}/approve`, v),
      ],
      [
        'recusar adjudicação alheia',
        B.post(`/api/v1/procurement/rfq-awards/${a.rfqAward.id}/reject`, { ...v, reason: 'x' }),
      ],
      [
        'anular adjudicação alheia',
        B.post(`/api/v1/procurement/rfq-awards/${a.rfqAward.id}/cancel`, { ...v, reason: 'x' }),
      ],
      ['GET ordem de compra', B.get(`/api/v1/procurement/orders/${a.purchaseOrder.id}`)],
      [
        'alterar ordem de compra alheia',
        B.put(`/api/v1/procurement/orders/${a.purchaseOrder.id}`, { ...v, lines: [] }),
      ],
      ['submit ordem alheia', B.post(`/api/v1/procurement/orders/${a.purchaseOrder.id}/submit`, v)],
      [
        'approve ordem alheia',
        B.post(`/api/v1/procurement/orders/${a.purchaseOrder.id}/approve`, v),
      ],
      ['issue ordem alheia', B.post(`/api/v1/procurement/orders/${a.purchaseOrder.id}/issue`, v)],
      [
        'reject ordem alheia',
        B.post(`/api/v1/procurement/orders/${a.purchaseOrder.id}/reject`, { ...v, reason: 'x' }),
      ],
      [
        'revise ordem alheia',
        B.post(`/api/v1/procurement/orders/${a.purchaseOrder.id}/revise`, { ...v, reason: 'x' }),
      ],
      [
        'cancel ordem alheia',
        B.post(`/api/v1/procurement/orders/${a.purchaseOrder.id}/cancel`, { ...v, reason: 'x' }),
      ],
      [
        'close ordem alheia',
        B.post(`/api/v1/procurement/orders/${a.purchaseOrder.id}/close`, { ...v, reason: 'x' }),
      ],
      [
        'ordens de adjudicação alheia',
        B.post(`/api/v1/procurement/rfq-awards/${a.rfqAward.id}/orders`),
      ],
      ['GET contrato', B.get(`/api/v1/procurement/contracts/${a.purchaseContract.id}`)],
      [
        'alterar contrato alheio',
        B.put(`/api/v1/procurement/contracts/${a.purchaseContract.id}`, { ...v, title: 'Outro' }),
      ],
      [
        'submit contrato alheio',
        B.post(`/api/v1/procurement/contracts/${a.purchaseContract.id}/submit`, v),
      ],
      [
        'approve contrato alheio',
        B.post(`/api/v1/procurement/contracts/${a.purchaseContract.id}/approve`, v),
      ],
      [
        'reactivate contrato alheio',
        B.post(`/api/v1/procurement/contracts/${a.purchaseContract.id}/reactivate`, v),
      ],
      [
        'reject contrato alheio',
        B.post(`/api/v1/procurement/contracts/${a.purchaseContract.id}/reject`, {
          ...v,
          reason: 'x',
        }),
      ],
      [
        'suspend contrato alheio',
        B.post(`/api/v1/procurement/contracts/${a.purchaseContract.id}/suspend`, {
          ...v,
          reason: 'x',
        }),
      ],
      [
        'terminate contrato alheio',
        B.post(`/api/v1/procurement/contracts/${a.purchaseContract.id}/terminate`, {
          ...v,
          reason: 'x',
        }),
      ],
      [
        'cancel contrato alheio',
        B.post(`/api/v1/procurement/contracts/${a.purchaseContract.id}/cancel`, {
          ...v,
          reason: 'x',
        }),
      ],
      [
        'adenda a contrato alheio',
        B.post(`/api/v1/procurement/contracts/${a.purchaseContract.id}/amendments`, {
          ...v,
          reason: 'x',
        }),
      ],
      [
        'approve adenda alheia',
        B.post(`/api/v1/procurement/contract-amendments/${a.contractAmendment.id}/approve`, {
          ...v,
          reason: 'x',
        }),
      ],
      [
        'reject adenda alheia',
        B.post(`/api/v1/procurement/contract-amendments/${a.contractAmendment.id}/reject`, {
          ...v,
          reason: 'x',
        }),
      ],
      [
        'cancel adenda alheia',
        B.post(`/api/v1/procurement/contract-amendments/${a.contractAmendment.id}/cancel`, {
          ...v,
          reason: 'x',
        }),
      ],
      ['GET recepção', B.get(`/api/v1/procurement/receipts/${a.purchaseReceipt.id}`)],
      [
        'ordem alheia por receber',
        B.get(`/api/v1/procurement/receipts/orders/${a.purchaseOrder.id}`),
      ],
      [
        'recepção de ordem alheia',
        B.post('/api/v1/procurement/receipts', { orderId: a.purchaseOrder.id, lines: [] }),
      ],
      [
        'alterar recepção alheia',
        B.put(`/api/v1/procurement/receipts/${a.purchaseReceipt.id}`, { ...v, lines: [] }),
      ],
      [
        'confirmar recepção alheia',
        B.post(`/api/v1/procurement/receipts/${a.purchaseReceipt.id}/confirm`, v),
      ],
      [
        'anular recepção alheia',
        B.post(`/api/v1/procurement/receipts/${a.purchaseReceipt.id}/cancel`, {
          ...v,
          reason: 'x',
        }),
      ],
      [
        'estornar recepção alheia',
        B.post(`/api/v1/procurement/receipts/${a.purchaseReceipt.id}/reverse`, {
          ...v,
          reason: 'x',
        }),
      ],
      ['GET factura de fornecedor', B.get(`/api/v1/procurement/invoices/${a.purchaseInvoice.id}`)],
      [
        'ordem alheia por facturar',
        B.get(`/api/v1/procurement/invoices/orders/${a.purchaseOrder.id}`),
      ],
      [
        'factura de ordem alheia',
        B.post('/api/v1/procurement/invoices', {
          orderId: a.purchaseOrder.id,
          invoiceNumber: 'X',
          lines: [],
        }),
      ],
      [
        'alterar factura alheia',
        B.put(`/api/v1/procurement/invoices/${a.purchaseInvoice.id}`, { ...v, lines: [] }),
      ],
      [
        'validar factura alheia',
        B.post(`/api/v1/procurement/invoices/${a.purchaseInvoice.id}/validate`, v),
      ],
      [
        'approve factura alheia',
        B.post(`/api/v1/procurement/invoices/${a.purchaseInvoice.id}/approve`, {
          ...v,
          reason: 'x',
        }),
      ],
      [
        'reject factura alheia',
        B.post(`/api/v1/procurement/invoices/${a.purchaseInvoice.id}/reject`, {
          ...v,
          reason: 'x',
        }),
      ],
      [
        'refuse factura alheia',
        B.post(`/api/v1/procurement/invoices/${a.purchaseInvoice.id}/refuse`, {
          ...v,
          reason: 'x',
        }),
      ],
      [
        'cancel factura alheia',
        B.post(`/api/v1/procurement/invoices/${a.purchaseInvoice.id}/cancel`, {
          ...v,
          reason: 'x',
        }),
      ],
      ['GET cliente alheio', B.get(`/api/v1/sales/customers/${a.customer.id}`)],
      [
        'alterar cliente alheio',
        B.patch(`/api/v1/sales/customers/${a.customer.id}`, { ...v, paymentTermsDays: 1 }),
      ],
      [
        'crédito de cliente alheio',
        B.post(`/api/v1/sales/customers/${a.customer.id}/credit`, {
          ...v,
          creditLimit: '1',
          reason: 'xxx',
        }),
      ],
      [
        'estado de cliente alheio',
        B.post(`/api/v1/sales/customers/${a.customer.id}/status`, {
          ...v,
          status: 'BLOCKED',
          reason: 'xxx',
        }),
      ],
      [
        'morada em cliente alheio',
        B.post(`/api/v1/sales/customers/${a.customer.id}/addresses`, {
          kind: 'BILLING',
          label: 'X',
          addressLine: 'Rua X',
          countryCode: 'AO',
        }),
      ],
      [
        'alterar morada alheia',
        B.patch(`/api/v1/sales/customers/${a.customer.id}/addresses/${a.customerAddress.id}`, {
          ...v,
          label: 'Outra',
        }),
      ],
      [
        'contacto em cliente alheio',
        B.post(`/api/v1/sales/customers/${a.customer.id}/contacts`, { name: 'X', email: 'x@x.ao' }),
      ],
      [
        'versão de cliente alheio',
        B.get(`/api/v1/sales/customers/${a.customer.id}/current-version`),
      ],
      [
        'cliente sobre terceiro alheio',
        B.post('/api/v1/sales/customers', { partnerId: a.supplier.partner.id, currency: 'AOA' }),
      ],
      ['GET recebimento alheio', B.get(`/api/v1/sales/receipts/${a.salesReceipt.id}`)],
      [
        'confirmar recebimento alheio',
        B.post(`/api/v1/sales/receipts/${a.salesReceipt.id}/confirm`, v),
      ],
      [
        'recusar recebimento alheio',
        B.post(`/api/v1/sales/receipts/${a.salesReceipt.id}/reject`, { ...v, reason: 'xxx' }),
      ],
      [
        'anular recebimento alheio',
        B.post(`/api/v1/sales/receipts/${a.salesReceipt.id}/cancel`, { ...v, reason: 'xxx' }),
      ],
      [
        'adiantamento alheio',
        B.post(`/api/v1/sales/receipts/${a.salesReceipt.id}/apply-advance`, {
          ...v,
          invoiceId: a.salesInvoice.id,
          amount: '1',
        }),
      ],
      [
        'pendentes de cliente alheio',
        B.get(`/api/v1/sales/receipts/open-items/${a.le.id}/${a.customer.id}`),
      ],
      [
        'GET submissão fiscal alheia',
        B.get(`/api/v1/sales/fiscal/submissions/${a.fiscalSubmission.id}`),
      ],
      [
        'submissão de documento alheio',
        B.get(`/api/v1/sales/fiscal/submissions/document/SALES_INVOICE/${a.salesInvoice.id}`),
      ],
      [
        'processar submissão alheia',
        B.post(`/api/v1/sales/fiscal/submissions/${a.fiscalSubmission.id}/process`, {}),
      ],
      [
        'repetir submissão alheia',
        B.post(`/api/v1/sales/fiscal/submissions/${a.fiscalSubmission.id}/requeue`, {
          ...v,
          reason: 'xxx',
        }),
      ],
      [
        'configurar integração de entidade alheia',
        B.put(`/api/v1/sales/fiscal/integration/${a.le.id}`, { provider: 'LOCAL_SIMULATOR' }),
      ],
      [
        'contingência de entidade alheia',
        B.post(`/api/v1/sales/fiscal/integration/${a.le.id}/contingency`, {
          active: true,
          reason: 'xxx',
        }),
      ],
      ['cobrança de cliente alheio', B.get(`/api/v1/sales/collections/${a.customer.id}`)],
      [
        'promessa para cliente alheio',
        B.post(`/api/v1/sales/collections/${a.customer.id}/promises`, {
          legalEntityId: a.le.id,
          amount: '1',
          promisedDate: '2099-01-01',
        }),
      ],
      [
        'contacto com cliente alheio',
        B.post(`/api/v1/sales/collections/${a.customer.id}/activities`, {
          legalEntityId: a.le.id,
          kind: 'CALL',
          outcome: 'OTHER',
          notes: 'xxxx',
        }),
      ],
      [
        'anular promessa alheia',
        B.post(`/api/v1/sales/collection-promises/${a.collectionPromise.id}/cancel`, {
          ...v,
          reason: 'xxx',
        }),
      ],
      ['GET nota alheia', B.get(`/api/v1/sales/notes/${a.salesNote.id}`)],
      [
        'alterar nota alheia',
        B.patch(`/api/v1/sales/notes/${a.salesNote.id}`, { ...v, reason: 'xxx' }),
      ],
      ['emitir nota alheia', B.post(`/api/v1/sales/notes/${a.salesNote.id}/issue`, v)],
      [
        'descartar nota alheia',
        B.post(`/api/v1/sales/notes/${a.salesNote.id}/discard`, { ...v, reason: 'xxx' }),
      ],
      [
        'crédito de nota alheia',
        B.post(`/api/v1/sales/notes/${a.salesNote.id}/apply-credit`, {
          ...v,
          invoiceId: a.salesInvoice.id,
          amount: '1',
        }),
      ],
      [
        'reembolso de nota alheia',
        B.post(`/api/v1/sales/notes/${a.salesNote.id}/refunds`, {
          requestKey: 'isolamento-r',
          amount: '1',
          method: 'CASH',
          refundDate: '2026-06-01',
        }),
      ],
      ['elegível de factura alheia', B.get(`/api/v1/sales/notes/eligible/${a.salesInvoice.id}`)],
      [
        'devolução em encomenda alheia',
        B.post(`/api/v1/sales/orders/${a.salesOrder.id}/returns`, {
          ...v,
          requestKey: 'isolamento-d',
          returnDate: '2026-06-01',
          reason: 'xxx',
          lines: [{ lineId: a.salesOrderLine.id, quantity: '1' }],
        }),
      ],
      ['GET factura alheia', B.get(`/api/v1/sales/invoices/${a.salesInvoice.id}`)],
      [
        'alterar factura alheia',
        B.patch(`/api/v1/sales/invoices/${a.salesInvoice.id}`, { ...v, notes: 'x' }),
      ],
      ['emitir factura alheia', B.post(`/api/v1/sales/invoices/${a.salesInvoice.id}/issue`, v)],
      [
        'descartar factura alheia',
        B.post(`/api/v1/sales/invoices/${a.salesInvoice.id}/discard`, { ...v, reason: 'xxx' }),
      ],
      ['facturar encomenda alheia', B.get(`/api/v1/sales/invoices/order-draft/${a.salesOrder.id}`)],
      [
        'factura a partir de encomenda alheia',
        B.post('/api/v1/sales/invoices', {
          orderId: a.salesOrder.id,
          invoiceDate: '2026-06-01',
          lines: [],
        }),
      ],
      ['GET imposto alheio', B.get(`/api/v1/sales/fiscal/tax-codes/${a.taxCode.id}`)],
      [
        'alterar imposto alheio',
        B.patch(`/api/v1/sales/fiscal/tax-codes/${a.taxCode.id}`, { ...v, name: 'Outro' }),
      ],
      [
        'taxa em imposto alheio',
        B.post(`/api/v1/sales/fiscal/tax-codes/${a.taxCode.id}/rates`, {
          rate: '1',
          validFrom: '2026-01-01',
          legalSource: 'Fonte de teste',
        }),
      ],
      [
        'alterar taxa alheia',
        B.patch(`/api/v1/sales/fiscal/tax-rates/${a.taxRate.id}`, { ...v, rate: '1' }),
      ],
      ['apagar taxa alheia', B.delete(`/api/v1/sales/fiscal/tax-rates/${a.taxRate.id}`)],
      [
        'confirmar taxa alheia',
        B.post(`/api/v1/sales/fiscal/tax-rates/${a.taxRate.id}/confirm`, v),
      ],
      [
        'alterar isenção alheia',
        B.patch(`/api/v1/sales/fiscal/exemptions/${a.taxExemption.id}`, {
          ...v,
          description: 'Outra',
        }),
      ],
      [
        'confirmar isenção alheia',
        B.post(`/api/v1/sales/fiscal/exemptions/${a.taxExemption.id}/confirm`, v),
      ],
      [
        'activar série alheia',
        B.post(`/api/v1/sales/fiscal/series/${a.fiscalSeries.id}/activate`, v),
      ],
      [
        'números de série alheia',
        B.get(`/api/v1/sales/fiscal/series/${a.fiscalSeries.id}/numbers`),
      ],
      [
        'arredondamento de entidade alheia',
        B.put(`/api/v1/sales/fiscal/settings/${a.le.id}`, { roundingLevel: 'DOCUMENT' }),
      ],
      ['GET encomenda alheia', B.get(`/api/v1/sales/orders/${a.salesOrder.id}`)],
      [
        'alterar encomenda alheia',
        B.patch(`/api/v1/sales/orders/${a.salesOrder.id}`, { ...v, notes: 'x' }),
      ],
      ['submeter encomenda alheia', B.post(`/api/v1/sales/orders/${a.salesOrder.id}/submit`, v)],
      ['reservar encomenda alheia', B.post(`/api/v1/sales/orders/${a.salesOrder.id}/reserve`, v)],
      [
        'expedir encomenda alheia',
        B.post(`/api/v1/sales/orders/${a.salesOrder.id}/deliver`, {
          ...v,
          requestKey: 'isolamento-01',
          deliveryDate: '2026-06-02',
          lines: [{ lineId: a.salesOrderLine.id, quantity: '1' }],
        }),
      ],
      [
        'anular encomenda alheia',
        B.post(`/api/v1/sales/orders/${a.salesOrder.id}/cancel`, { ...v, reason: 'xxx' }),
      ],
      [
        'converter orçamento alheio',
        B.post('/api/v1/sales/orders/from-quote', { quoteId: a.salesQuote.id }),
      ],
      ['moradas de cliente alheio', B.get(`/api/v1/sales/orders/addresses/${a.customer.id}`)],
      ['GET orçamento alheio', B.get(`/api/v1/sales/quotes/${a.salesQuote.id}`)],
      [
        'alterar orçamento alheio',
        B.patch(`/api/v1/sales/quotes/${a.salesQuote.id}`, { ...v, notes: 'x' }),
      ],
      ['submeter orçamento alheio', B.post(`/api/v1/sales/quotes/${a.salesQuote.id}/submit`, v)],
      [
        'enviar orçamento alheio',
        B.post(`/api/v1/sales/quotes/${a.salesQuote.id}/send`, { ...v, channel: 'HAND' }),
      ],
      [
        'anular orçamento alheio',
        B.post(`/api/v1/sales/quotes/${a.salesQuote.id}/cancel`, { ...v, reason: 'xxx' }),
      ],
      ['GET tabela de preços alheia', B.get(`/api/v1/sales/price-lists/${a.priceList.id}`)],
      [
        'alterar tabela de preços alheia',
        B.patch(`/api/v1/sales/price-lists/${a.priceList.id}`, { ...v, name: 'Outra' }),
      ],
      [
        'linha em tabela alheia',
        B.post(`/api/v1/sales/price-lists/${a.priceList.id}/lines`, {
          productId: a.product.id,
          unitPrice: '1',
        }),
      ],
      [
        'alterar linha de tabela alheia',
        B.patch(`/api/v1/sales/price-lists/${a.priceList.id}/lines/${a.priceListLine.id}`, {
          ...v,
          unitPrice: '1',
        }),
      ],
      [
        'apagar linha de tabela alheia',
        B.delete(`/api/v1/sales/price-lists/${a.priceList.id}/lines/${a.priceListLine.id}`),
      ],
      ['submeter tabela alheia', B.post(`/api/v1/sales/price-lists/${a.priceList.id}/submit`, v)],
      [
        'copiar tabela alheia',
        B.post(`/api/v1/sales/price-lists/${a.priceList.id}/copy`, {
          code: 'COPIA',
          validFrom: '2026-01-01',
        }),
      ],
      ['GET regra de desconto alheia', B.get(`/api/v1/sales/discount-rules/${a.discountRule.id}`)],
      [
        'alterar regra alheia',
        B.patch(`/api/v1/sales/discount-rules/${a.discountRule.id}`, { ...v, name: 'Outra' }),
      ],
      [
        'submeter regra alheia',
        B.post(`/api/v1/sales/discount-rules/${a.discountRule.id}/submit`, v),
      ],
      ['apagar limite alheio', B.delete(`/api/v1/sales/discount-limits/${a.discountLimit.id}`)],
      [
        'alterar segmento alheio',
        B.patch(`/api/v1/sales/segments/${a.customerSegment.id}`, { ...v, name: 'Outro' }),
      ],
      ['GET avaliação alheia', B.get(`/api/v1/procurement/evaluations/${a.supplierEvaluation.id}`)],
      [
        'provas de fornecedor alheio',
        B.get(`/api/v1/procurement/evaluations/suppliers/${a.supplier.id}?from=2026-01-01`),
      ],
      [
        'publicar avaliação de fornecedor alheio',
        B.post(`/api/v1/procurement/evaluations/suppliers/${a.supplier.id}`, {
          from: '2026-01-01',
        }),
      ],
      ['GET verba alheia', B.get(`/api/v1/procurement/budgets/${a.procurementBudget.id}`)],
      [
        'alterar verba alheia',
        B.put(`/api/v1/procurement/budgets/${a.procurementBudget.id}`, { ...v, amount: '1' }),
      ],
      [
        'verba num centro de custo alheio',
        B.post('/api/v1/procurement/budgets', {
          costCenterId: a.costCenter.id,
          fiscalYear: 2027,
          amount: '1',
        }),
      ],
      ['GET obrigação alheia', B.get(`/api/v1/procurement/payables/${a.procurementPayable.id}`)],
      [
        'pagar obrigação alheia',
        B.post(`/api/v1/procurement/payables/${a.procurementPayable.id}/payments`, {
          ...v,
          amount: '1',
        }),
      ],
      [
        'repetir contabilização alheia',
        B.post(`/api/v1/procurement/payables/${a.procurementPayable.id}/accounting/retry`, {}),
      ],
      ['GET devolução alheia', B.get(`/api/v1/procurement/returns/${a.purchaseReturn.id}`)],
      [
        'recepção alheia por devolver',
        B.get(`/api/v1/procurement/returns/receipts/${a.purchaseReceipt.id}`),
      ],
      [
        'devolução de recepção alheia',
        B.post('/api/v1/procurement/returns', { receiptId: a.purchaseReceipt.id, lines: [] }),
      ],
      [
        'alterar devolução alheia',
        B.put(`/api/v1/procurement/returns/${a.purchaseReturn.id}`, { ...v, lines: [] }),
      ],
      [
        'confirmar devolução alheia',
        B.post(`/api/v1/procurement/returns/${a.purchaseReturn.id}/confirm`, v),
      ],
      [
        'anular devolução alheia',
        B.post(`/api/v1/procurement/returns/${a.purchaseReturn.id}/cancel`, { ...v, reason: 'x' }),
      ],
      [
        'GET nota de crédito alheia',
        B.get(`/api/v1/procurement/credit-notes/${a.purchaseCreditNote.id}`),
      ],
      [
        'factura alheia por creditar',
        B.get(`/api/v1/procurement/credit-notes/invoices/${a.purchaseInvoice.id}`),
      ],
      [
        'nota de crédito de factura alheia',
        B.post('/api/v1/procurement/credit-notes', {
          invoiceId: a.purchaseInvoice.id,
          creditNoteNumber: 'X',
          lines: [],
        }),
      ],
      [
        'alterar nota de crédito alheia',
        B.put(`/api/v1/procurement/credit-notes/${a.purchaseCreditNote.id}`, { ...v, lines: [] }),
      ],
      [
        'validar nota de crédito alheia',
        B.post(`/api/v1/procurement/credit-notes/${a.purchaseCreditNote.id}/validate`, v),
      ],
      [
        'anular nota de crédito alheia',
        B.post(`/api/v1/procurement/credit-notes/${a.purchaseCreditNote.id}/cancel`, {
          ...v,
          reason: 'x',
        }),
      ],
      ['GET fornecedor', B.get(`/api/v1/procurement/suppliers/${a.supplier.id}`)],
      [
        'alterar fornecedor alheio',
        B.patch(`/api/v1/procurement/suppliers/${a.supplier.id}`, { ...v, paymentTermsDays: 1 }),
      ],
      [
        'contacto no fornecedor alheio',
        B.post(`/api/v1/procurement/suppliers/${a.supplier.id}/contacts`, {
          name: 'X',
          email: 'x@x.ao',
        }),
      ],
      [
        'alterar contacto alheio',
        B.patch(
          `/api/v1/procurement/suppliers/${a.supplier.id}/contacts/${a.supplier.partner.contacts[0].id}`,
          { ...v, name: 'Outro' }
        ),
      ],
      [
        'conta bancária no fornecedor alheio',
        B.post(`/api/v1/procurement/suppliers/${a.supplier.id}/bank-accounts`, {
          holderName: 'X',
          bankName: 'X',
          iban: 'AO44004000000987654321098',
        }),
      ],
      [
        'aprovar conta bancária alheia',
        B.post(
          `/api/v1/procurement/supplier-bank-accounts/${a.supplier.bankAccounts[0].id}/approve`,
          v
        ),
      ],
      [
        'documento no fornecedor alheio',
        B.post(`/api/v1/procurement/suppliers/${a.supplier.id}/documents`, {
          documentTypeId: a.supplierDocType.id,
        }),
      ],
      [
        'desactivar documento alheio',
        B.post(`/api/v1/procurement/supplier-documents/${a.supplier.documents[0].id}/deactivate`, {
          ...v,
          reason: 'x',
        }),
      ],
      [
        'pedir homologação alheia',
        B.post(`/api/v1/procurement/suppliers/${a.supplier.id}/submit`, { ...v, items: [] }),
      ],
      ['homologar alheio', B.post(`/api/v1/procurement/suppliers/${a.supplier.id}/approve`, v)],
      [
        'recusar alheio',
        B.post(`/api/v1/procurement/suppliers/${a.supplier.id}/reject`, { ...v, reason: 'x' }),
      ],
      [
        'suspender alheio',
        B.post(`/api/v1/procurement/suppliers/${a.supplier.id}/suspend`, { ...v, reason: 'x' }),
      ],
      [
        'alterar critério alheio',
        B.patch(`/api/v1/procurement/settings/criteria/${a.supplierCriterion.id}`, {
          ...v,
          name: 'Outro',
        }),
      ],
      [
        'alterar tipo de documento alheio',
        B.patch(`/api/v1/procurement/settings/document-types/${a.supplierDocType.id}`, {
          ...v,
          name: 'Outro',
        }),
      ],
      ['GET lote', B.get(`/api/v1/inventory/lots/${a.stockLot.id}`)],
      [
        'bloquear lote alheio',
        B.post(`/api/v1/inventory/lots/${a.stockLot.id}/block`, { ...v, reason: 'x' }),
      ],
      [
        'desbloquear lote alheio',
        B.post(`/api/v1/inventory/lots/${a.stockLot.id}/unblock`, { ...v, reason: 'x' }),
      ],
      [
        'recolher lote alheio',
        B.post(`/api/v1/inventory/lots/${a.stockLot.id}/recall`, { ...v, reason: 'x' }),
      ],
      ['GET série', B.get(`/api/v1/inventory/serials/${a.stockSerial.id}`)],
      ['GET contagem', B.get(`/api/v1/inventory/counts/${a.stockCount.id}`)],
      [
        'PUT contagem',
        B.put(`/api/v1/inventory/counts/${a.stockCount.id}`, { ...v, description: 'x' }),
      ],
      ['iniciar contagem alheia', B.post(`/api/v1/inventory/counts/${a.stockCount.id}/start`, v)],
      [
        'contar contagem alheia',
        B.post(`/api/v1/inventory/counts/${a.stockCount.id}/count`, { ...v, lines: [] }),
      ],
      [
        'acrescentar linha a contagem alheia',
        B.post(`/api/v1/inventory/counts/${a.stockCount.id}/lines`, {
          ...v,
          productId: a.product.id,
        }),
      ],
      ['submeter contagem alheia', B.post(`/api/v1/inventory/counts/${a.stockCount.id}/submit`, v)],
      [
        'justificar contagem alheia',
        B.post(`/api/v1/inventory/counts/${a.stockCount.id}/justify`, { ...v, lines: [] }),
      ],
      [
        'pedir recontagem alheia',
        B.post(`/api/v1/inventory/counts/${a.stockCount.id}/recount`, {
          ...v,
          reason: 'x',
          lineIds: [],
        }),
      ],
      ['aprovar contagem alheia', B.post(`/api/v1/inventory/counts/${a.stockCount.id}/approve`, v)],
      [
        'anular contagem alheia',
        B.post(`/api/v1/inventory/counts/${a.stockCount.id}/cancel`, { ...v, reason: 'x' }),
      ],
      ['GET requisição', B.get(`/api/v1/inventory/requisitions/${a.stockRequisition.id}`)],
      [
        'PUT requisição',
        B.put(`/api/v1/inventory/requisitions/${a.stockRequisition.id}`, {
          ...v,
          purpose: 'x',
          lines: [],
        }),
      ],
      [
        'submeter requisição alheia',
        B.post(`/api/v1/inventory/requisitions/${a.stockRequisition.id}/submit`, v),
      ],
      [
        'aprovar requisição alheia',
        B.post(`/api/v1/inventory/requisitions/${a.stockRequisition.id}/approve`, v),
      ],
      [
        'anular requisição alheia',
        B.post(`/api/v1/inventory/requisitions/${a.stockRequisition.id}/cancel`, {
          ...v,
          reason: 'x',
        }),
      ],
      ['GET transferência', B.get(`/api/v1/inventory/transfers/${a.stockTransfer.id}`)],
      [
        'PUT transferência',
        B.put(`/api/v1/inventory/transfers/${a.stockTransfer.id}`, { ...v, lines: [] }),
      ],
      [
        'submeter transferência alheia',
        B.post(`/api/v1/inventory/transfers/${a.stockTransfer.id}/submit`, v),
      ],
      [
        'aprovar transferência alheia',
        B.post(`/api/v1/inventory/transfers/${a.stockTransfer.id}/approve`, v),
      ],
      [
        'anular transferência alheia',
        B.post(`/api/v1/inventory/transfers/${a.stockTransfer.id}/cancel`, { ...v, reason: 'x' }),
      ],
      [
        'lançamento de stock alheio',
        B.get(`/api/v1/inventory/stock/postings/${a.stockPosting.id}`),
      ],
      [
        'mudança de estado em armazém alheio',
        B.post('/api/v1/inventory/stock/status-changes', {
          warehouseId: a.warehouse.id,
          productId: a.product.id,
          variantId: a.variant.id,
          from: 'UNRESTRICTED',
          to: 'BLOCKED',
          quantity: '1',
          reason: 'x',
          idempotencyKey: 'matriz-b-status',
        }),
      ],
      ['GET armazém', B.get(`/api/v1/inventory/warehouses/${a.warehouse.id}`)],
      [
        'PATCH armazém',
        B.patch(`/api/v1/inventory/warehouses/${a.warehouse.id}`, { ...v, name: 'xxx' }),
      ],
      [
        'localização em armazém alheio',
        B.post(`/api/v1/inventory/warehouses/${a.warehouse.id}/locations`, { code: 'ZB' }),
      ],
      [
        'PATCH localização',
        B.patch(`/api/v1/inventory/warehouse-locations/${a.location.id}`, { ...v, name: 'x' }),
      ],
      [
        'acesso a armazém alheio',
        B.put(`/api/v1/inventory/warehouses/${a.warehouse.id}/access`, {
          membershipId: a.warehouse.id,
          level: 'VIEW',
        }),
      ],
      ['GET produto', B.get(`/api/v1/inventory/products/${a.product.id}`)],
      [
        'PATCH produto',
        B.patch(`/api/v1/inventory/products/${a.product.id}`, { ...v, name: 'xx' }),
      ],
      ['procura por SKU alheio', B.get('/api/v1/inventory/products/lookup?code=SKU-A')],
      ['procura por código alheio', B.get('/api/v1/inventory/products/lookup?code=INT-A-001')],
      [
        'variante em produto alheio',
        B.post(`/api/v1/inventory/products/${a.product.id}/variants`, {
          sku: 'SKU-B-V',
          attributes: { Cor: 'Verde' },
        }),
      ],
      [
        'PATCH variante',
        B.patch(`/api/v1/inventory/product-variants/${a.variant.id}`, { ...v, status: 'INACTIVE' }),
      ],
      [
        'PATCH unidade',
        B.patch(`/api/v1/inventory/settings/uoms/${a.uom.id}`, { ...v, name: 'x' }),
      ],
      [
        'PATCH categoria de produto',
        B.patch(`/api/v1/inventory/settings/categories/${a.productCategory.id}`, {
          ...v,
          name: 'x',
        }),
      ],
      [
        'PATCH marca',
        B.patch(`/api/v1/inventory/settings/brands/${a.brand.id}`, { ...v, name: 'x' }),
      ],
      [
        'anexos do produto',
        B.get(`/api/v1/attachments?subjectType=product&subjectId=${a.product.id}`),
      ],
      ['GET cessação', B.get(`/api/v1/hr/terminations/${a.termination.id}`)],
      [
        'abrir cessação',
        B.post(`/api/v1/hr/employees/${a.leaver.id}/terminations`, {
          reason: 'RESIGNATION',
          details: 'xxxx',
          lastWorkingDay: '2026-12-31',
          indemnityApplicable: false,
        }),
      ],
      [
        'PATCH cessação',
        B.patch(`/api/v1/hr/terminations/${a.termination.id}`, { ...v, details: 'xxxx' }),
      ],
      [
        'linha da liquidação',
        B.post(`/api/v1/hr/terminations/${a.termination.id}/lines`, {
          ...v,
          kind: 'OTHER_EARNING',
          componentId: a.payComponent.id,
          description: 'xxx',
          amount: '1',
          basis: 'xxx',
        }),
      ],
      ['submeter cessação', B.post(`/api/v1/hr/terminations/${a.termination.id}/submit`, v)],
      [
        'decidir cessação',
        B.post(`/api/v1/hr/terminations/${a.termination.id}/decision`, { ...v, approve: true }),
      ],
      [
        'cancelar cessação',
        B.post(`/api/v1/hr/terminations/${a.termination.id}/cancel`, { ...v, reason: 'x' }),
      ],
      ['liquidação final', B.post(`/api/v1/hr/terminations/${a.termination.id}/settlement`, v)],
      ['concluir cessação', B.post(`/api/v1/hr/terminations/${a.termination.id}/complete`, v)],
      [
        'tarefa da cessação',
        B.post(`/api/v1/hr/terminations/${a.termination.id}/tasks`, {
          ...v,
          category: 'OTHER',
          title: 'xxxx',
        }),
      ],
      [
        'estado da tarefa',
        B.patch(`/api/v1/hr/termination-tasks/${a.termination.tasks[0].id}`, {
          ...v,
          status: 'DONE',
        }),
      ],
      [
        'anexos da cessação',
        B.get(`/api/v1/attachments?subjectType=employee_termination&subjectId=${a.termination.id}`),
      ],
      ['GET carreira', B.get(`/api/v1/hr/employees/${a.employee.id}/assignments`)],
      [
        'movimento',
        B.post(`/api/v1/hr/employees/${a.employee.id}/assignments`, {
          ...v,
          kind: 'CHANGE',
          effectiveDate: '2026-03-01',
          managerId: null,
          reason: 'xxx',
        }),
      ],
      ['GET onboarding', B.get(`/api/v1/hr/employees/${a.employee.id}/onboarding`)],
      [
        'nova tarefa de onboarding',
        B.post(`/api/v1/hr/employees/${a.employee.id}/onboarding`, {
          category: 'OTHER',
          title: 'xx',
        }),
      ],
      [
        'PATCH tarefa de onboarding',
        B.patch(`/api/v1/hr/onboarding-tasks/${a.onboardingTask.id}`, { ...v, status: 'DONE' }),
      ],
      ['GET dimensão', B.get(`/api/v1/accounting/dimensions/${a.dimension.id}`)],
      [
        'PATCH dimensão',
        B.patch(`/api/v1/accounting/dimensions/${a.dimension.id}`, { ...v, name: 'xx' }),
      ],
      [
        'valor em dimensão de A',
        B.post(`/api/v1/accounting/dimensions/${a.dimension.id}/values`, { code: 'Z', name: 'Zz' }),
      ],
      ['GET chave', B.get(`/api/v1/accounting/allocation-keys/${a.allocKey.id}`)],
      [
        'PATCH chave',
        B.patch(`/api/v1/accounting/allocation-keys/${a.allocKey.id}`, { ...v, name: 'xx' }),
      ],
      ['imputações de A', B.get(`/api/v1/accounting/entries/${a.entry.id}/allocations`)],
      [
        'imputar linha de A',
        B.put(`/api/v1/accounting/entries/${a.entry.id}/lines/1/allocations`, { allocations: [] }),
      ],
      ['analítica de A', B.get(`/api/v1/accounting/analytics?fiscalYearId=${a.fy.id}`)],
      [
        'GET plano de regularização',
        B.get(`/api/v1/accounting/adjustment-schedules/${a.schedule.id}`),
      ],
      [
        'PATCH plano de regularização',
        B.patch(`/api/v1/accounting/adjustment-schedules/${a.schedule.id}`, { ...v, name: 'xx' }),
      ],
      [
        'gerar regularizações de A',
        B.post('/api/v1/accounting/adjustments/generate', {
          legalEntityId: a.le.id,
          upTo: '2026-12',
        }),
      ],
      [
        'simular regularizações de A',
        B.get(`/api/v1/accounting/adjustments/preview?legalEntityId=${a.le.id}&upTo=2026-12`),
      ],
      ['GET provisão', B.get(`/api/v1/accounting/provisions/${a.provision.id}`)],
      [
        'PATCH provisão',
        B.patch(`/api/v1/accounting/provisions/${a.provision.id}`, { ...v, name: 'xx' }),
      ],
      [
        'movimentar provisão',
        B.post(`/api/v1/accounting/provisions/${a.provision.id}/movements`, {
          type: 'CONSTITUTION',
          date: '2026-02-01',
          amount: '1',
          reason: 'xxx',
        }),
      ],
      [
        'actualização cambial de A',
        B.get(
          `/api/v1/accounting/fx-revaluations/preview?legalEntityId=${a.le.id}&date=2026-03-31&accountIds=${a.accountA.id}`
        ),
      ],
      [
        'linhas em aberto de A',
        B.get(
          `/api/v1/accounting/reconciliations/open-items?legalEntityId=${a.le.id}&accountId=${a.accountA.id}`
        ),
      ],
      [
        'reconciliar linhas de A',
        B.post('/api/v1/accounting/reconciliations', {
          legalEntityId: a.le.id,
          accountId: a.accountA.id,
          lines: [
            { entryId: a.entry.id, lineNo: 1 },
            { entryId: a.entry.id, lineNo: 2 },
          ],
        }),
      ],
      ['checklist de período de A', B.get(`/api/v1/accounting/periods/${a.period.id}/checklist`)],
      [
        'tarefa em período de A',
        B.post(`/api/v1/accounting/periods/${a.period.id}/tasks`, { title: 'xxx' }),
      ],
      ['copiar tarefas de A', B.post(`/api/v1/accounting/periods/${a.period.id}/tasks/copy`)],
      [
        'PATCH tarefa de A',
        B.patch(`/api/v1/accounting/close-tasks/${a.closeTask.id}`, { ...v, done: true }),
      ],
      ['DELETE tarefa de A', B.delete(`/api/v1/accounting/close-tasks/${a.closeTask.id}`)],
      ['encerramento de A', B.get(`/api/v1/accounting/fiscal-years/${a.fy.id}/closing`)],
      ['encerrar exercício de A', B.post(`/api/v1/accounting/fiscal-years/${a.fy.id}/close`, {})],
      [
        'reabrir exercício de A',
        B.post(`/api/v1/accounting/fiscal-years/${a.fy.id}/reopen`, { reason: 'xxxxx' }),
      ],
      [
        'GET modelo de demonstração',
        B.get(`/api/v1/accounting/statement-templates/${a.stmtTemplate.id}`),
      ],
      [
        'PATCH modelo de demonstração',
        B.patch(`/api/v1/accounting/statement-templates/${a.stmtTemplate.id}`, { name: 'xx' }),
      ],
      [
        'publicar modelo de A',
        B.post(`/api/v1/accounting/statement-templates/${a.stmtTemplate.id}/publish`),
      ],
      [
        'nova versão de modelo de A',
        B.post(`/api/v1/accounting/statement-templates/${a.stmtTemplate.id}/versions`),
      ],
      [
        'demonstração de A',
        B.get(
          `/api/v1/accounting/statements?templateId=${a.stmtTemplate.id}&fiscalYearId=${a.fy.id}`
        ),
      ],
      ['notas de A', B.get(`/api/v1/accounting/statement-notes?fiscalYearId=${a.fy.id}`)],
      [
        'PATCH nota de A',
        B.patch(`/api/v1/accounting/statement-notes/${a.stmtNote.id}`, {
          ...v,
          number: 1,
          title: 'xx',
          body: 'xx',
        }),
      ],
      ['DELETE nota de A', B.delete(`/api/v1/accounting/statement-notes/${a.stmtNote.id}`)],
      ['GET classe de activos', B.get(`/api/v1/accounting/fixed-asset-classes/${a.assetClass.id}`)],
      [
        'PATCH classe de activos',
        B.patch(`/api/v1/accounting/fixed-asset-classes/${a.assetClass.id}`, { ...v, name: 'xx' }),
      ],
      ['GET activo', B.get(`/api/v1/accounting/fixed-assets/${a.asset.id}`)],
      [
        'PATCH activo',
        B.patch(`/api/v1/accounting/fixed-assets/${a.asset.id}`, { ...v, name: 'xx' }),
      ],
      ['DELETE activo', B.delete(`/api/v1/accounting/fixed-assets/${a.asset.id}`)],
      [
        'adquirir activo',
        B.post(`/api/v1/accounting/fixed-assets/${a.asset.id}/acquire`, {
          ...v,
          counterpartAccountId: a.accountA.id,
        }),
      ],
      [
        'transferir activo',
        B.post(`/api/v1/accounting/fixed-assets/${a.asset.id}/transfer`, {
          ...v,
          date: '2026-02-01',
        }),
      ],
      [
        'abater activo',
        B.post(`/api/v1/accounting/fixed-assets/${a.asset.id}/dispose`, {
          ...v,
          date: '2026-02-01',
          reason: 'xx',
        }),
      ],
      [
        'simular depreciação de A',
        B.get(
          `/api/v1/accounting/fixed-assets/depreciation/preview?legalEntityId=${a.le.id}&upTo=2026-12`
        ),
      ],
      [
        'depreciar entidade de A',
        B.post('/api/v1/accounting/fixed-assets/depreciation/run', {
          legalEntityId: a.le.id,
          upTo: '2026-12',
        }),
      ],
      [
        'mapa de depreciação de A',
        B.get(`/api/v1/accounting/fixed-assets/depreciation-map?fiscalYearId=${a.fy.id}`),
      ],
      ['balancete de A', B.get(`/api/v1/accounting/trial-balance?fiscalYearId=${a.fy.id}`)],
      [
        'razão de A',
        B.get(
          `/api/v1/accounting/ledger?legalEntityId=${a.le.id}&accountId=${a.accountA.id}&from=2026-01-01&to=2026-12-31`
        ),
      ],
      [
        'abertura em exercício de A',
        B.post('/api/v1/accounting/opening-balances/validate', {
          fiscalYearId: a.fy.id,
          journalId: a.journal.id,
          lines: [],
        }),
      ],
      ['suspender membro', B.post(`/api/v1/members/${a.member}/suspend`, v)],
      ['GET workflow', B.get(`/api/v1/approvals/workflows/${a.wf.id}`)],
      ['retirar workflow', B.post(`/api/v1/approvals/workflows/${a.wf.id}/retire`, v)],
      ['GET pedido', B.get(`/api/v1/approvals/requests/${a.request.id}`)],
      [
        'decidir pedido',
        B.post(`/api/v1/approvals/requests/${a.request.id}/decisions`, { decision: 'APPROVE' }),
      ],
      ['cancelar pedido', B.post(`/api/v1/approvals/requests/${a.request.id}/cancel`, {})],
      ['revogar delegação', B.post(`/api/v1/approvals/delegations/${a.delegation.id}/revoke`)],
      ['descarregar anexo', B.get(`/api/v1/attachments/${a.attachment.id}/content`)],
      ['eliminar anexo', B.delete(`/api/v1/attachments/${a.attachment.id}`)],
      [
        'listar anexos de A',
        B.get(`/api/v1/attachments?subjectType=legal_entity&subjectId=${a.le.id}`),
      ],
      ['marcar notificação', B.post(`/api/v1/me/notifications/${a.notification.id}/read`)],
      ['GET câmbio', B.get(`/api/v1/exchange-rates/${a.rate.id}`)],
      ['PATCH câmbio', B.patch(`/api/v1/exchange-rates/${a.rate.id}`, { ...v, rate: '1' })],
      ['GET série', B.get(`/api/v1/document-series/${a.series.id}`)],
      ['PATCH série', B.patch(`/api/v1/document-series/${a.series.id}`, { ...v, name: 'x' })],
      ['pré-visualizar série', B.get(`/api/v1/document-series/${a.series.id}/preview`)],
      ['GET calendário', B.get(`/api/v1/calendars/${a.calendar.id}`)],
      [
        'dias úteis',
        B.get(`/api/v1/calendars/${a.calendar.id}/working-days?from=2026-11-01&to=2026-11-30`),
      ],
      [
        'feriado em calendário de A',
        B.post(`/api/v1/calendars/${a.calendar.id}/holidays`, {
          date: '2026-12-25',
          name: 'Natal',
        }),
      ],
      ['remover feriado', B.delete(`/api/v1/calendars/${a.calendar.id}/holidays/${a.holiday.id}`)],
      ['GET conta bancária', B.get(`/api/v1/bank-accounts/${a.bank.id}`)],
      [
        'PATCH conta bancária',
        B.patch(`/api/v1/bank-accounts/${a.bank.id}`, { ...v, isDefault: true }),
      ],
      [
        'dependentes da entidade',
        B.get(`/api/v1/organization/legal-entities/${a.le.id}/dependents`),
      ],
    ]
    const wrong: string[] = []
    for (const [name, promise] of attempts) {
      const status = (await promise).status()
      if (status !== 404) wrong.push(`${name} → ${status}`)
    }
    assert.deepEqual(wrong, [])

    // Preços: o cliente, o produto e o segmento de A não servem a B (recusados sem revelar dados de A).
    const crossPricing = [
      await B.post('/api/v1/sales/pricing/resolve', {
        customerId: a.customer.id,
        currency: 'AOA',
        date: '2026-06-01',
        lines: [{ productId: a.product.id, quantity: '1' }],
      }),
      await B.post('/api/v1/sales/price-lists', {
        code: 'X-B',
        name: 'Tabela B',
        currency: 'AOA',
        targetType: 'SEGMENT',
        segmentId: a.customerSegment.id,
        validFrom: '2026-01-01',
      }),
      await B.put('/api/v1/sales/discount-limits', {
        targetType: 'CUSTOMER',
        customerId: a.customer.id,
        maxPct: '50',
      }),
    ]
    crossPricing.push(
      await B.post('/api/v1/sales/quotes', {
        legalEntityId: a.le.id,
        customerId: a.customer.id,
        quoteDate: '2026-06-01',
        validUntil: '2026-06-30',
        lines: [],
      })
    )
    crossPricing.push(
      await B.post('/api/v1/sales/orders', {
        legalEntityId: a.le.id,
        customerId: a.customer.id,
        orderDate: '2026-06-01',
        lines: [],
      })
    )
    assert.notInclude(
      (await B.get('/api/v1/sales/orders')).body().data.map((x: any) => x.id),
      a.salesOrder.id
    )
    assert.notInclude(
      (await B.get('/api/v1/sales/quotes')).body().data.map((x: any) => x.id),
      a.salesQuote.id
    )
    crossPricing.push(
      await B.post('/api/v1/sales/fiscal/simulate', {
        legalEntityId: a.le.id,
        date: '2026-06-01',
        lines: [{ netAmount: '1.00', taxCodeIds: [a.taxCode.id] }],
      }),
      await B.post('/api/v1/sales/fiscal/series', {
        legalEntityId: a.le.id,
        documentKind: 'INVOICE',
        fiscalCode: 'FT',
        code: 'X',
        fiscalYear: 2026,
        prefix: 'X/',
      })
    )
    assert.lengthOf((await B.get('/api/v1/sales/fiscal/series')).body().data.items, 0)
    crossPricing.push(
      await B.post('/api/v1/sales/invoices', {
        legalEntityId: a.le.id,
        customerId: a.customer.id,
        invoiceDate: '2026-06-01',
        lines: [],
      })
    )
    assert.notInclude(
      (await B.get('/api/v1/sales/invoices')).body().data.map((x: any) => x.id),
      a.salesInvoice.id
    )
    crossPricing.push(
      await B.post('/api/v1/sales/receipts', {
        legalEntityId: a.le.id,
        customerId: a.customer.id,
        amount: '1',
        method: 'CASH',
        receivedDate: '2026-06-01',
        requestKey: 'isolamento-b',
      })
    )
    crossPricing.push(
      await B.post('/api/v1/sales/notes', {
        kind: 'CREDIT',
        invoiceId: a.salesInvoice.id,
        reasonCode: 'OTHER',
        reason: 'Isolamento',
        noteDate: '2026-06-01',
        lines: [{ invoiceLineId: a.salesInvoice.id, mode: 'VALUE', amount: '1' }],
      })
    )
    assert.notInclude(
      (await B.get('/api/v1/sales/notes')).body().data.map((x: any) => x.id),
      a.salesNote.id
    )
    assert.notInclude(
      (await B.get('/api/v1/sales/fiscal/submissions')).body().data.map((x: any) => x.id),
      a.fiscalSubmission.id
    )
    // A fila de B nunca processa a submissão de A.
    await B.post('/api/v1/sales/fiscal/submissions/process', {})
    const aSub = await db
      .connection('owner')
      .rawQuery(`select status, attempts from fiscal_submissions where id = ?`, [
        a.fiscalSubmission.id,
      ])
    assert.deepEqual([aSub.rows[0].status, aSub.rows[0].attempts], ['FAILED', 0])
    for (const r of crossPricing) {
      assert.include([404, 422], r.status())
      assert.notInclude(JSON.stringify(r.body()), 'PL-A')
    }
    const aLimit = await db
      .connection('owner')
      .rawQuery(`select max_pct from discount_limits where id = ?`, [a.discountLimit.id])
    assert.equal(Number(aLimit.rows[0].max_pct), 5)

    // Referências a ids de A em escritas de B: recusadas (nunca ligam linhas de empresas diferentes).
    const crossRun = await B.post('/api/v1/hr/payroll/runs', {
      legalEntityId: a.employee.legalEntityId,
      period: '2026-04',
      kind: 'EXTRA',
    })
    crossRun.assertStatus(422)
    const crossRef = await B.post('/api/v1/organization/branches', {
      code: 'BRX',
      name: 'Filial cruzada',
      legalEntityId: a.le.id,
    })
    assert.include([404, 422], crossRef.status())
    ;(await upload(client, b, 'legal_entity', a.le.id)).assertStatus(404)
    ;(await upload(client, b, 'employee', a.employee.id)).assertStatus(404)
    const wfCross = await B.post('/api/v1/approvals/workflows', {
      code: 'WFX',
      name: 'Workflow cruzado',
      subjectType: 'manual',
      steps: [{ name: 'Etapa', approverType: 'MEMBER', approverMembershipId: a.member }],
    })
    wfCross.assertStatus(422)
    const assignCross = await B.post(
      `/api/v1/members/${(await B.get('/api/v1/context')).body().data.membershipId}/roles`,
      { roleId: a.role.id }
    )
    assert.include([403, 404, 422], assignCross.status())

    // Listas de B não contêm nada de A.
    const lists = await Promise.all([
      B.get('/api/v1/organization/legal-entities'),
      B.get('/api/v1/roles'),
      B.get('/api/v1/members'),
      B.get('/api/v1/approvals/workflows'),
      B.get('/api/v1/approvals/requests'),
      B.get('/api/v1/approvals/delegations?all=true'),
      B.get('/api/v1/audit-events?limit=200'),
      B.get('/api/v1/me/notifications'),
      B.get('/api/v1/me/tasks'),
      B.get('/api/v1/exchange-rates'),
      B.get('/api/v1/document-series'),
      B.get('/api/v1/calendars'),
      B.get('/api/v1/bank-accounts'),
      B.get('/api/v1/organization/departments/tree'),
      B.get('/api/v1/accounting/charts'),
      B.get('/api/v1/accounting/accounts'),
      B.get('/api/v1/accounting/fiscal-years'),
      B.get('/api/v1/accounting/journals'),
      B.get('/api/v1/accounting/entries'),
      B.get('/api/v1/accounting/posting-rules'),
      B.get('/api/v1/accounting/posting-events'),
      B.get('/api/v1/accounting/dimensions'),
      B.get('/api/v1/accounting/allocation-keys'),
      B.get('/api/v1/accounting/fixed-asset-classes'),
      B.get('/api/v1/accounting/fixed-assets'),
      B.get('/api/v1/accounting/adjustment-schedules'),
      B.get('/api/v1/accounting/provisions'),
      B.get('/api/v1/accounting/fx-revaluations'),
      B.get('/api/v1/accounting/statement-templates'),
    ])
    const idsOfA = new Set(
      [
        a.le.id,
        a.branch.id,
        a.role.id,
        a.member,
        a.wf.id,
        a.request.id,
        a.delegation.id,
        a.audit.id,
        a.rate.id,
        a.series.id,
        a.calendar.id,
        a.bank.id,
        a.chart.id,
        a.accountA.id,
        a.fy.id,
        a.journal.id,
        a.entry.id,
        a.rule.id,
        a.postingEvent.id,
        a.dimension.id,
        a.allocKey.id,
        a.assetClass.id,
        a.asset.id,
        a.schedule.id,
        a.provision.id,
        a.stmtTemplate.id,
        a.stmtNote.id,
      ].map(String)
    )
    const leaked = lists.flatMap((r) =>
      (r.body().data as any[]).filter((item) => idsOfA.has(item.id) || idsOfA.has(item.subjectId))
    )
    assert.deepEqual(leaked, [])

    // A pesquisa global de B não encontra nada de A.
    for (const q of ['Entidade A', 'Filial A', 'Pedido A', 'aprovador_a', 'Workflow A']) {
      const hits = (await B.get(`/api/v1/search?q=${encodeURIComponent(q)}`)).body().data as any[]
      assert.deepEqual(
        hits.filter((h) => idsOfA.has(h.id)),
        [],
        q
      )
    }
    // O painel de B só conta registos de B.
    const dash = (await B.get('/api/v1/dashboard')).body().data
    assert.equal(dash.organization.legalEntities, 0)
    assert.equal(dash.members.ACTIVE, 1)

    // Nada de A mudou.
    const owner = db.connection('owner')
    const le = await owner.rawQuery('select version, trade_name from legal_entities where id = ?', [
      a.le.id,
    ])
    assert.deepEqual(le.rows[0], { version: 1, trade_name: null })
    const req = await owner.rawQuery('select status from approval_requests where id = ?', [
      a.request.id,
    ])
    assert.equal(req.rows[0].status, 'PENDING')
    const att = await owner.rawQuery('select status from attachments where id = ?', [
      a.attachment.id,
    ])
    assert.equal(att.rows[0].status, 'ACTIVE')
    // Perfil e configurações são por empresa: B vê os seus (vazios), nunca os de A.
    const profile = (await B.get('/api/v1/company/profile')).body().data
    assert.notEqual(profile.displayName, 'Marca A')
    const hol = await owner.rawQuery(
      'select count(*)::int as n from calendar_holidays where id = ?',
      [a.holiday.id]
    )
    assert.equal(hol.rows[0].n, 1)
    const lookup = await B.get('/api/v1/exchange-rates/lookup?from=USD&to=AOA&date=2026-02-01')
    lookup.assertStatus(404)
    // Referências cruzadas na contabilidade: B não usa diário, plano ou contas de A.
    const leB = (
      await B.post('/api/v1/organization/legal-entities', {
        code: 'LEB',
        legalName: 'Entidade B, Lda.',
        taxId: '5000000202',
        countryCode: 'AO',
        functionalCurrency: 'AOA',
      })
    ).body().data
    const crossEntry = await B.post('/api/v1/accounting/entries', {
      legalEntityId: leB.id,
      journalId: a.journal.id,
      entryDate: '2026-02-10',
      description: 'Cruzado',
      lines: [{ accountId: a.accountA.id, debit: '1' }],
    })
    crossEntry.assertStatus(422)
    const crossAccount = await B.post('/api/v1/accounting/accounts', {
      chartId: a.chart.id,
      code: '9',
      name: 'Cruzada',
      level: 'CLASS',
      nature: 'ASSET',
    })
    crossAccount.assertStatus(422)
    // Um colaborador de B não se liga à estrutura de A.
    const crossEmployee = await B.post('/api/v1/hr/employees', {
      code: 'COL-X',
      fullName: 'Cruzado',
      legalEntityId: a.le.id,
      hireDate: '2026-01-05',
    })
    assert.include([403, 404, 422], crossEmployee.status())
    const crossManager = await B.post('/api/v1/hr/employees', {
      code: 'COL-Y',
      fullName: 'Cruzado',
      legalEntityId: leB.id,
      managerId: a.employee.id,
      hireDate: '2026-01-05',
    })
    crossManager.assertStatus(422)
    // Candidatura de B com a vaga ou o candidato de A: recusada (inexistentes para B).
    const crossApplication = await B.post('/api/v1/hr/applications', {
      requisitionId: a.requisition.id,
      candidateId: a.candidate.id,
    })
    assert.equal(crossApplication.status(), 422)
    // As listas de B não trazem nada de A.
    for (const url of [
      '/api/v1/hr/requisitions',
      '/api/v1/hr/candidates',
      '/api/v1/hr/applications',
    ])
      assert.lengthOf((await B.get(url)).body().data, 0, url)
    assert.lengthOf((await B.get('/api/v1/hr/interviews/mine')).body().data, 0)
    assert.lengthOf((await B.get('/api/v1/hr/loans')).body().data, 0)
    assert.lengthOf((await B.get('/api/v1/hr/payroll/runs')).body().data, 0)
    assert.lengthOf((await B.get('/api/v1/hr/payslips')).body().data, 0)
    assert.lengthOf((await B.get('/api/v1/hr/training/sessions')).body().data, 0)
    assert.lengthOf((await B.get('/api/v1/hr/training/courses')).body().data, 0)
    assert.lengthOf((await B.get('/api/v1/hr/discipline/cases')).body().data, 0)
    assert.lengthOf((await B.get('/api/v1/hr/terminations')).body().data, 0)
    assert.lengthOf((await B.get('/api/v1/inventory/products')).body().data, 0)
    assert.lengthOf((await B.get('/api/v1/inventory/warehouses')).body().data, 0)
    assert.lengthOf((await B.get('/api/v1/inventory/stock/balances')).body().data, 0)
    assert.lengthOf((await B.get('/api/v1/inventory/documents')).body().data, 0)
    assert.lengthOf((await B.get('/api/v1/inventory/transfers')).body().data, 0)
    assert.lengthOf((await B.get('/api/v1/inventory/requisitions')).body().data, 0)
    assert.lengthOf((await B.get('/api/v1/inventory/reservations')).body().data, 0)
    assert.lengthOf((await B.get('/api/v1/inventory/counts')).body().data, 0)
    assert.lengthOf((await B.get('/api/v1/inventory/lots')).body().data, 0)
    assert.lengthOf((await B.get('/api/v1/inventory/valuation')).body().data, 0)
    assert.lengthOf((await B.get('/api/v1/inventory/integrations/events')).body().data, 0)
    assert.lengthOf((await B.get('/api/v1/inventory/accounting-events')).body().data, 0)
    assert.lengthOf((await B.get('/api/v1/inventory/serials')).body().data, 0)
    assert.lengthOf((await B.get('/api/v1/procurement/suppliers')).body().data, 0)
    assert.lengthOf((await B.get('/api/v1/procurement/requisitions')).body().data, 0)
    assert.lengthOf((await B.get('/api/v1/procurement/requisitions/demand')).body().data, 0)
    assert.lengthOf((await B.get('/api/v1/procurement/approval-levels')).body().data, 0)
    assert.lengthOf((await B.get('/api/v1/procurement/settings/criteria')).body().data, 0)
    assert.lengthOf((await B.get('/api/v1/procurement/settings/document-types')).body().data, 0)
    assert.deepEqual(
      (await B.get('/api/v1/procurement/suppliers/lookup?countryCode=AO&taxId=5000099001')).body()
        .data,
      { partner: null, supplierId: null }
    )
    assert.lengthOf((await B.get('/api/v1/inventory/reports/replenishment')).body().data, 0)
    assert.lengthOf((await B.get('/api/v1/inventory/reports/expiry')).body().data, 0)
    assert.lengthOf(
      (await B.get('/api/v1/inventory/reports/movements?from=2026-01-01&to=2026-12-31')).body().data
        .rows,
      0
    )
    assert.notInclude(
      JSON.stringify((await B.get('/api/v1/inventory/counts/options')).body().data),
      a.warehouse.id
    )
    assert.notInclude(
      JSON.stringify((await B.get('/api/v1/inventory/requisitions/options')).body().data),
      a.warehouse.id
    )
    assert.notInclude(
      JSON.stringify((await B.get('/api/v1/inventory/transfers/destinations')).body().data),
      a.warehouse.id
    )
    assert.lengthOf((await B.get('/api/v1/inventory/stock/movements')).body().data, 0)
    assert.lengthOf(
      (await B.get(`/api/v1/inventory/stock/balances?warehouseId=${a.warehouse.id}`)).body().data,
      0
    )
    assert.equal(
      (await B.get(`/api/v1/inventory/stock/reconciliation?warehouseId=${a.warehouse.id}`)).body()
        .data.checked,
      0
    )
    assert.lengthOf((await B.get('/api/v1/inventory/settings/uoms')).body().data, 0)
    const hc = (await B.get('/api/v1/hr/reports/headcount')).body().data
    assert.notInclude(JSON.stringify(hc), a.le.id)
    assert.notInclude(
      JSON.stringify((await B.get('/api/v1/hr/reports/leave?year=2026')).body().data),
      'Colaborador A'
    )
    assert.equal(
      (await B.get(`/api/v1/hr/reports/payroll?year=2026&legalEntityId=${a.le.id}`)).status(),
      404
    )
    assert.lengthOf((await B.get('/api/v1/hr/payroll/rule-sets')).body().data, 0)
    for (const url of [
      '/api/v1/hr/leave/requests',
      '/api/v1/hr/leave/types',
      '/api/v1/hr/leave/policies',
    ])
      assert.lengthOf((await B.get(url)).body().data, 0, url)
    // Gerar direitos em B não toca colaboradores de A.
    const accrual = (
      await B.post('/api/v1/hr/leave/accruals', { year: 2026, employeeIds: [a.employee.id] })
    ).body().data
    assert.equal(accrual.created + accrual.adjusted + accrual.unchanged + accrual.skipped.length, 0)
    // Eventos de B com a entidade legal de A não usam as regras de A.
    const crossEvent = await B.post('/api/v1/accounting/posting-events', {
      legalEntityId: a.le.id,
      source: 'SALES_INVOICE',
      event: 'ISSUED',
      sourceRef: 'FT X',
      occurredOn: '2026-02-11',
      amounts: { total: '5' },
    })
    assert.include([404, 422], crossEvent.status())
    const eventsOfA = await owner.rawQuery(
      'select count(*)::int as n from posting_events where tenant_id = ?',
      [a.tenantId]
    )
    assert.equal(eventsOfA.rows[0].n, 1)
    const entryA = await owner.rawQuery(
      'select status, description from journal_entries where id = ?',
      [a.entry.id]
    )
    assert.deepEqual(entryA.rows[0], { status: 'DRAFT', description: 'Lançamento A' })
  })

  test('com a sessão de B e X-Tenant-Id de A todas as rotas de empresa são negadas', async ({
    client,
    assert,
  }) => {
    const a = await populate(client)
    const { tenant, admin } = await tenantWithAdmin()
    const b = await signIn(client, admin.email, tenant.id)
    const spoof = as(client, { ...b, tenantId: a.tenantId })
    for (const url of [
      '/api/v1/context',
      '/api/v1/organization/legal-entities',
      `/api/v1/organization/legal-entities/${a.le.id}`,
      '/api/v1/members',
      '/api/v1/approvals/requests',
      `/api/v1/attachments/${a.attachment.id}/content`,
      '/api/v1/audit-events',
      '/api/v1/me/notifications',
      '/api/v1/company/profile',
      '/api/v1/settings',
      '/api/v1/exchange-rates',
      `/api/v1/bank-accounts/${a.bank.id}`,
      '/api/v1/accounting/entries',
      `/api/v1/accounting/charts/${a.chart.id}`,
      '/api/v1/hr/employees',
      `/api/v1/hr/employees/${a.employee.id}`,
      '/api/v1/hr/requisitions',
      `/api/v1/hr/applications/${a.application.id}`,
      '/api/v1/hr/candidates',
      '/api/v1/hr/settings',
      `/api/v1/hr/contracts/${a.contract.id}`,
      `/api/v1/hr/employees/${a.employee.id}/assignments`,
      '/api/v1/hr/leave/requests',
      `/api/v1/hr/employees/${a.employee.id}/leave`,
      `/api/v1/hr/employees/${a.employee.id}/compensation`,
      '/api/v1/hr/compensation/proposals',
      '/api/v1/hr/loans',
      '/api/v1/hr/payroll/runs',
      '/api/v1/hr/payroll/rule-sets',
      '/api/v1/hr/training/sessions',
      '/api/v1/hr/discipline/cases',
      '/api/v1/hr/terminations',
      '/api/v1/inventory/products',
      '/api/v1/inventory/settings/categories',
      '/api/v1/inventory/warehouses',
      '/api/v1/inventory/stock/balances',
      '/api/v1/inventory/documents',
      '/api/v1/inventory/transfers',
      '/api/v1/inventory/requisitions',
      '/api/v1/inventory/reservations',
      '/api/v1/inventory/counts',
      '/api/v1/inventory/lots',
      '/api/v1/inventory/serials',
      '/api/v1/inventory/valuation',
      '/api/v1/inventory/integrations/events',
      '/api/v1/inventory/accounting-events',
      '/api/v1/inventory/reports/replenishment',
      '/api/v1/procurement/suppliers',
      '/api/v1/procurement/requisitions',
      `/api/v1/procurement/requisitions/${a.purchaseRequisition.id}`,
      `/api/v1/procurement/suppliers/${a.supplier.id}`,
      '/api/v1/procurement/rfqs',
      `/api/v1/procurement/rfqs/${a.rfq.id}`,
      `/api/v1/procurement/rfq-awards/${a.rfqAward.id}`,
      '/api/v1/procurement/orders',
      '/api/v1/procurement/contracts',
      '/api/v1/procurement/receipts',
      '/api/v1/procurement/invoices',
      `/api/v1/procurement/invoices/${a.purchaseInvoice.id}`,
      '/api/v1/procurement/receipts/expected',
      `/api/v1/procurement/receipts/${a.purchaseReceipt.id}`,
      `/api/v1/procurement/contracts/${a.purchaseContract.id}`,
      `/api/v1/procurement/orders/${a.purchaseOrder.id}`,
      '/api/v1/procurement/rfqs?pendingAward=true',
      '/api/v1/inventory/reports/expiry',
      '/api/v1/inventory/stock/movements',
      '/api/v1/hr/me',
      '/api/v1/hr/team',
      '/api/v1/hr/reports/headcount',
      '/api/v1/hr/reports/payroll?year=2026',
      `/api/v1/hr/employees/${a.employee.id}/loans`,
    ]) {
      const r = await spoof.get(url)
      assert.equal(r.status(), 403, url)
      assert.equal(r.body().error.code, 'TENANT_ACCESS_DENIED', url)
    }
  })
})
