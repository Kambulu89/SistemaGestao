import { test } from '@japa/runner'
import db from '@adonisjs/lucid/services/db'
import { iamServices } from '#core/permissions/index'
import { deleteTestUsers, resetAuthState } from '#tests/support/auth_fixture'
import { createActiveTenant, deleteTestTenants } from '#tests/support/membership_fixture'
import { api, newActor } from '#tests/support/api_fixture'
import { automationServices } from '#dynamic/automations/index'
import type { Tenant } from '#platform/tenants/index'

/**
 * Prova de ponta a ponta do motor configurável (Fase 3): «Viatura» não existe no código — é um tenant a definir, só pela
 * API, uma entidade com formulário, regra, máquina de estados, aprovação e automação, e a usá-la com pesquisa e auditoria.
 */
type Http = ReturnType<typeof api>

async function must<T>(response: { status(): number; body(): any }, status: number): Promise<T> {
  if (response.status() !== status) {
    throw new Error(
      `Esperado ${status}, obtido ${response.status()}: ${JSON.stringify(response.body())}`
    )
  }
  return response.body().data as T
}

const rowsOf = (tenant: Tenant, sql: string) =>
  db.connection('owner').transaction(async (trx) => {
    await trx.rawQuery("select set_config('app.tenant_id', ?, true)", [tenant.id])
    return (await trx.rawQuery(sql)).rows as any[]
  })

async function memberWith(client: any, tenant: Tenant, admin: Http, permissions: string[]) {
  const actor = await newActor(client, tenant)
  const role = await must<{ id: string }>(
    await admin.post('/api/v1/roles', {
      code: `r_${Math.random().toString(36).slice(2, 10)}`,
      name: 'Papel de teste',
      permissionCodes: permissions,
    }),
    201
  )
  await must(
    await admin.post('/api/v1/role-assignments', {
      membershipId: actor.membershipId,
      roleId: role.id,
    }),
    201
  )
  return { actor, http: api(client, tenant, actor) }
}

const fields = () => [
  {
    code: 'matricula',
    label: 'Matrícula',
    type: 'TEXT',
    required: true,
    validation: { pattern: '^[A-Z]{2}-\\d{2}-[A-Z]{2}$', unique: true },
    presentation: { searchable: true },
  },
  { code: 'marca', label: 'Marca', type: 'TEXT', presentation: { searchable: true } },
  { code: 'km', label: 'Quilometragem', type: 'NUMBER', validation: { min: 0 } },
  {
    code: 'custo_manutencao',
    label: 'Custo de manutenção',
    type: 'DECIMAL',
    validation: { precision: 12, scale: 2 },
  },
  { code: 'moeda', label: 'Moeda', type: 'TEXT' },
  {
    code: 'valor_aquisicao',
    label: 'Valor de aquisição',
    type: 'DECIMAL',
    sensitive: true,
    validation: { precision: 12, scale: 2 },
  },
]

const records = '/api/v1/dynamic/viatura/records'

test.group('motor configurável | Viatura de ponta a ponta', (group) => {
  group.setup(async () => {
    await iamServices().syncCatalog.execute()
  })
  group.each.setup(async () => {
    await resetAuthState()
    return async () => {
      await deleteTestTenants()
      await deleteTestUsers()
    }
  })

  test('metadados, formulário, regra, estados, aprovação e automação, com pesquisa e auditoria', async ({
    client,
    assert,
  }) => {
    const tenant = await createActiveTenant()
    const admin = await newActor(client, tenant, true)
    const http = api(client, tenant, admin)

    // --- C10: a entidade, publicada (versão 1) --------------------------------------------------
    const draft = await must<any>(
      await http.post('/api/v1/entity-definitions', {
        code: 'viatura',
        name: 'Viatura',
        presentation: { pluralName: 'Viaturas', icon: 'truck' },
        fields: fields(),
      }),
      201
    )
    const entity = await must<any>(
      await http.post(`/api/v1/entity-definitions/${draft.entity.id}/publish`, {
        expectedVersion: draft.entity.version,
      }),
      200
    )
    assert.equal(entity.entity.publishedVersion, 1)

    // --- C11: formulário publicado ---------------------------------------------------------------
    const form = await must<any>(
      await http.post('/api/v1/forms', {
        entityCode: 'viatura',
        code: 'ficha',
        name: 'Ficha da viatura',
        isDefault: true,
        sections: [
          {
            key: 'identificacao',
            title: 'Identificação',
            columns: 2,
            items: [
              { kind: 'field', field: 'matricula', span: 2 },
              { kind: 'field', field: 'marca' },
              { kind: 'field', field: 'km' },
            ],
          },
          {
            key: 'manutencao',
            title: 'Manutenção',
            columns: 2,
            items: [
              { kind: 'field', field: 'custo_manutencao' },
              { kind: 'field', field: 'moeda' },
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

    // --- C12: validação de quilometragem ---------------------------------------------------------
    const rule = await must<any>(
      await http.post('/api/v1/rules', {
        entityCode: 'viatura',
        code: 'km_verosimil',
        name: 'Quilometragem verosímil',
        conditionAst: { op: 'gt', left: { var: 'resource.km' }, right: { value: 999999 } },
        actionAst: { type: 'BLOCK', message: 'Quilometragem inverosímil', field: 'km' },
      }),
      201
    )
    await must(
      await http.post(`/api/v1/rules/${rule.id}/publish`, { expectedVersion: rule.version }),
      200
    )

    // --- C13: o ciclo de vida ---------------------------------------------------------------------
    const machine = await must<any>(
      await http.post('/api/v1/state-machines', {
        entityCode: 'viatura',
        code: 'ciclo',
        name: 'Ciclo da viatura',
        states: [
          { code: 'disponivel', label: 'Disponível', category: 'INITIAL' },
          { code: 'em_manutencao', label: 'Em manutenção', category: 'ACTIVE' },
          { code: 'operacional', label: 'Operacional', category: 'ACTIVE' },
        ],
        transitions: [
          {
            code: 'enviar_manutencao',
            label: 'Enviar para manutenção',
            from: ['disponivel', 'operacional'],
            to: 'em_manutencao',
          },
          {
            code: 'concluir_manutencao',
            label: 'Concluir manutenção',
            from: ['em_manutencao'],
            to: 'operacional',
          },
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

    // --- Pessoas: a gestora de frota, a chefia que aprova e quem só consulta -------------------------
    const manager = await memberWith(client, tenant, http, [
      'entity.read',
      'dynamic.read',
      'dynamic.create',
      'dynamic.update',
      'dynamic.transition',
      'workflow.submit',
      'automation.read',
      'automation.manage',
    ])
    const boss = await memberWith(client, tenant, http, ['approval.decide'])
    const viewer = await memberWith(client, tenant, http, ['entity.read', 'dynamic.read'])

    // --- C14: aprovação da manutenção ----------------------------------------------------------------
    const workflow = await must<any>(
      await http.post('/api/v1/workflows', {
        entityCode: 'viatura',
        code: 'manutencao',
        name: 'Aprovação de manutenção',
        graph: {
          amountField: 'custo_manutencao',
          currencyField: 'moeda',
          stages: [
            {
              code: 'chefia',
              label: 'Chefia de frota',
              criteria: 'ALL',
              approvers: [{ type: 'MEMBERSHIP', id: boss.actor.membershipId }],
              dueInHours: 48,
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

    // --- C15: aprovada a manutenção, a viatura passa a «Em manutenção» --------------------------------
    const automation = await must<any>(
      await manager.http.post('/api/v1/automations', {
        code: 'manutencao_aprovada',
        name: 'Enviar para manutenção quando aprovada',
        eventType: 'workflow.instance.approved',
        condition: {
          op: 'eq',
          left: { var: 'resource.workflowCode' },
          right: { value: 'manutencao' },
        },
        actions: [
          {
            type: 'dynamic.record.transition',
            params: {
              entityCode: 'viatura',
              recordId: { from: 'payload.recordId' },
              transition: 'enviar_manutencao',
              reason: 'Manutenção aprovada',
            },
          },
        ],
      }),
      201
    )
    await must(
      await manager.http.post(`/api/v1/automations/${automation.id}/activate`, {
        expectedVersion: automation.version,
      }),
      200
    )

    // === Uso ====================================================================================
    // Formulário publicado disponível a quem lê a entidade.
    const forms = await must<any[]>(await viewer.http.get('/api/v1/dynamic/viatura/forms'), 200)
    assert.deepEqual(
      forms.map((f) => f.code),
      ['ficha']
    )

    // Matrícula inválida, duplicada e quilometragem inverosímil são recusadas com a mensagem de negócio.
    const bad = await manager.http.post(records, { data: { matricula: 'abc', km: 10 } })
    bad.assertStatus(422)
    const car = await must<any>(
      await manager.http.post(records, {
        data: {
          matricula: 'LD-12-AB',
          marca: 'Toyota',
          km: 120000,
          custo_manutencao: '350.00',
          moeda: 'AOA',
        },
      }),
      201
    )
    assert.equal(car.state.code, 'disponivel')
    ;(
      await manager.http.post(records, { data: { matricula: 'LD-12-AB', marca: 'Outra' } })
    ).assertStatus(409)
    const insane = await manager.http.post(records, {
      data: { matricula: 'LD-13-AB', km: 2000000 },
    })
    insane.assertStatus(422)
    assert.include(JSON.stringify(insane.body()), 'Quilometragem inverosímil')

    // Campos sensíveis: quem não tem a permissão não os escreve nem os lê; o administrador sim.
    ;(
      await manager.http.post(records, { data: { matricula: 'LD-14-AB', valor_aquisicao: '1.00' } })
    ).assertStatus(403)
    const priced = await must<any>(
      await http.post(records, {
        data: { matricula: 'LD-15-AB', marca: 'Hilux', valor_aquisicao: '25000.00' },
      }),
      201
    )
    assert.equal(
      (await must<any>(await http.get(`${records}/${priced.id}`), 200)).data.valor_aquisicao,
      '25000.00'
    )
    assert.notProperty(
      (await must<any>(await manager.http.get(`${records}/${priced.id}`), 200)).data,
      'valor_aquisicao'
    )

    // Pesquisa de texto nos campos pesquisáveis.
    const found = await must<any[]>(await viewer.http.get(`${records}?q=toyota`), 200)
    assert.deepEqual(
      found.map((r) => r.data.matricula),
      ['LD-12-AB']
    )
    assert.lengthOf(await must<any[]>(await viewer.http.get(`${records}?q=nada-disto`), 200), 0)

    // Quem só consulta não escreve, não submete e não transita.
    ;(
      await viewer.http.patch(`${records}/${car.id}`, {
        expectedVersion: car.version,
        data: { km: 1 },
      })
    ).assertStatus(403)
    ;(
      await viewer.http.post('/api/v1/workflow-instances', {
        entityCode: 'viatura',
        workflowCode: 'manutencao',
        recordId: car.id,
      })
    ).assertStatus(403)

    // Submete à aprovação; a chefia aprova; a automação envia para manutenção em nome de quem a activou.
    const submitted = await must<any>(
      await manager.http.post('/api/v1/workflow-instances', {
        entityCode: 'viatura',
        workflowCode: 'manutencao',
        recordId: car.id,
      }),
      201
    )
    assert.equal(submitted.instance.snapshot.custo_manutencao, '350.00')
    const [task] = await must<any[]>(await boss.http.get('/api/v1/approval-tasks'), 200)
    assert.equal(task.amount, '350.00')
    assert.equal(task.currency, 'AOA')
    await must(await boss.http.post(`/api/v1/approval-tasks/${task.task.id}/approve`, {}), 200)

    for (let i = 0; i < 10; i++) {
      const r = await automationServices().engine.processTenant(tenant.id)
      if (r.dispatched + r.scheduled + r.executed === 0) break
    }
    const current = await must<any>(await manager.http.get(`${records}/${car.id}`), 200)
    assert.equal(current.state.code, 'em_manutencao')
    const history = await must<any[]>(
      await manager.http.get(`${records}/${car.id}/state-history`),
      200
    )
    assert.deepInclude(history.at(-1), {
      transitionCode: 'enviar_manutencao',
      toState: 'em_manutencao',
      reason: 'Manutenção aprovada',
      actorMembershipId: manager.actor.membershipId,
    })
    const runs = await must<any[]>(await manager.http.get('/api/v1/automation-runs'), 200)
    assert.deepEqual(
      runs.map((r) => [r.automationCode, r.status, r.depth]),
      [['manutencao_aprovada', 'SUCCEEDED', 1]]
    )

    // A cadeia fica registada: aprovação (sem causa) → execução → mudança de estado (nível 1).
    const events = await rowsOf(
      tenant,
      `select event_type, causation_depth from outbox_events where event_type in
         ('workflow.instance.approved', 'dynamic.record.state_changed') order by created_at, id`
    )
    assert.deepEqual(
      events.map((e) => [e.event_type, e.causation_depth]),
      [
        ['workflow.instance.approved', 0],
        ['dynamic.record.state_changed', 1],
      ]
    )

    // Alterar a viatura depois de submetida já não afecta nada em curso; a quilometragem continua a ser validada.
    ;(
      await manager.http.patch(`${records}/${car.id}`, {
        expectedVersion: current.version,
        data: { km: 5000000 },
      })
    ).assertStatus(422)

    // --- Auditoria: quem fez o quê, sem valores sensíveis --------------------------------------------
    const logs = await must<any[]>(
      await http.get(`/api/v1/audit-logs?resourceType=dynamic_records&resourceId=${priced.id}`),
      200
    )
    assert.isAbove(logs.length, 0)
    assert.notInclude(JSON.stringify(logs), '25000.00')
    const automationLogs = await must<any[]>(
      await http.get('/api/v1/audit-logs?resourceType=automation_runs'),
      200
    )
    assert.isAbove(automationLogs.length, 0)
    ;(await viewer.http.get('/api/v1/audit-logs?resourceType=dynamic_records')).assertStatus(403)

    // --- Versões antigas permanecem legíveis ----------------------------------------------------------
    const v2 = await must<any>(
      await http.post(`/api/v1/entity-definitions/${draft.entity.id}/drafts`, {}),
      201
    )
    const withColour = await must<any>(
      await http.put(`/api/v1/entity-definitions/${draft.entity.id}/draft`, {
        expectedVersion: v2.entity.version,
        fields: [...fields(), { code: 'cor', label: 'Cor', type: 'TEXT' }],
      }),
      200
    )
    await must(
      await http.post(`/api/v1/entity-definitions/${draft.entity.id}/publish`, {
        expectedVersion: withColour.entity.version,
      }),
      200
    )
    const old = await must<any>(await manager.http.get(`${records}/${car.id}`), 200)
    assert.equal(old.data.matricula, 'LD-12-AB')
    assert.equal(
      old.schemaVersion.revision,
      1,
      'o registo continua ligado à versão em que foi escrito'
    )

    // --- Isolamento: outro tenant não vê nada disto ----------------------------------------------------
    const other = await createActiveTenant()
    const otherAdmin = await newActor(client, other, true)
    const otherHttp = api(client, other, otherAdmin)
    ;(await otherHttp.get(`${records}/${car.id}`)).assertStatus(404)
    assert.lengthOf(await must<any[]>(await otherHttp.get('/api/v1/automations'), 200), 0)
    assert.lengthOf(await must<any[]>(await otherHttp.get('/api/v1/automation-runs'), 200), 0)
    assert.lengthOf(await must<any[]>(await otherHttp.get('/api/v1/workflow-instances'), 200), 0)
  })
})
