import { test } from '@japa/runner'
import {
  as,
  cleanDatabase,
  createRole,
  memberWithRoles,
  signIn,
  tenantWithAdmin,
} from '#tests/support/fixtures'

const ORG = '/api/v1/organization'

async function adminSession(client: any, code?: string) {
  const { tenant, admin } = await tenantWithAdmin(code)
  return signIn(client, admin.email, tenant.id)
}

async function legalEntity(client: any, s: any, code = 'LE1', taxId = '5000000001') {
  const r = await as(client, s).post(`${ORG}/legal-entities`, {
    code,
    legalName: `Entidade ${code}, Lda.`,
    taxId,
    countryCode: 'ao',
    functionalCurrency: 'aoa',
  })
  if (r.status() !== 201) throw new Error(JSON.stringify(r.body()))
  return r.body().data
}

test.group(
  'organização | entidades, filiais, departamentos, cargos e centros de custo',
  (group) => {
    group.each.setup(() => cleanDatabase())

    test('entidade legal: normaliza, exige campos, código e NIF únicos, código imutável, versão', async ({
      client,
      assert,
    }) => {
      const s = await adminSession(client)
      const le = await legalEntity(client, s)
      assert.deepInclude(le, {
        code: 'LE1',
        countryCode: 'AO',
        functionalCurrency: 'AOA',
        status: 'ACTIVE',
        validFrom: null,
      })
      const missing = await as(client, s).post(`${ORG}/legal-entities`, { code: 'X' })
      missing.assertStatus(422)
      assert.includeMembers(
        missing.body().error.details.map((d: any) => d.path),
        ['legalName', 'taxId', 'countryCode', 'functionalCurrency']
      )
      const sameCode = await as(client, s).post(`${ORG}/legal-entities`, {
        code: 'LE1',
        legalName: 'Outra',
        taxId: '5000000002',
        countryCode: 'AO',
        functionalCurrency: 'AOA',
      })
      sameCode.assertStatus(409)
      sameCode.assertBodyContains({ error: { code: 'LEGAL_ENTITY_CODE_TAKEN' } })
      const sameTax = await as(client, s).post(`${ORG}/legal-entities`, {
        code: 'LE2',
        legalName: 'Outra',
        taxId: '5000000001',
        countryCode: 'AO',
        functionalCurrency: 'AOA',
      })
      sameTax.assertStatus(409)
      sameTax.assertBodyContains({ error: { code: 'TAX_ID_TAKEN' } })

      const immutable = await as(client, s).patch(`${ORG}/legal-entities/${le.id}`, {
        expectedVersion: 1,
        code: 'OUTRO',
      })
      immutable.assertStatus(422)
      const badPeriod = await as(client, s).patch(`${ORG}/legal-entities/${le.id}`, {
        expectedVersion: 1,
        validFrom: '2026-02-01',
        validTo: '2026-01-01',
      })
      badPeriod.assertStatus(422)
      badPeriod.assertBodyContains({ error: { details: [{ code: 'INVALID_PERIOD' }] } })
      const inactive = await as(client, s).patch(`${ORG}/legal-entities/${le.id}`, {
        expectedVersion: 1,
        status: 'INACTIVE',
      })
      inactive.assertStatus(200)
      assert.equal(inactive.body().data.version, 2)
      ;(
        await as(client, s).patch(`${ORG}/legal-entities/${le.id}`, {
          expectedVersion: 1,
          status: 'ACTIVE',
        })
      ).assertStatus(409)
      const list = await as(client, s).get(`${ORG}/legal-entities?status=INACTIVE&q=entidade`)
      assert.equal(list.body().meta.total, 1)
    })

    test('departamentos e centros de custo ficam na mesma entidade legal; árvore sem ciclos', async ({
      client,
      assert,
    }) => {
      const s = await adminSession(client)
      const a = await legalEntity(client, s, 'LEA', '5000000011')
      const b = await legalEntity(client, s, 'LEB', '5000000012')
      const branchB = (
        await as(client, s).post(`${ORG}/branches`, {
          code: 'FB',
          name: 'Filial B',
          legalEntityId: b.id,
        })
      ).body().data
      const otherBranch = await as(client, s).post(`${ORG}/departments`, {
        code: 'D0',
        name: 'Errado',
        legalEntityId: a.id,
        branchId: branchB.id,
      })
      otherBranch.assertStatus(422)
      otherBranch.assertBodyContains({
        error: { details: [{ path: 'branchId', code: 'OTHER_LEGAL_ENTITY' }] },
      })

      const create = async (code: string, parentId: string | null) =>
        (
          await as(client, s).post(`${ORG}/departments`, {
            code,
            name: `Dep ${code}`,
            legalEntityId: a.id,
            parentId,
          })
        ).body().data
      const top = await create('DIR', null)
      const mid = await create('FIN', top.id)
      const leaf = await create('CONT', mid.id)
      const cycle = await as(client, s).patch(`${ORG}/departments/${top.id}`, {
        expectedVersion: 1,
        parentId: leaf.id,
      })
      cycle.assertStatus(422)
      cycle.assertBodyContains({ error: { details: [{ code: 'CYCLE' }] } })
      const self = await as(client, s).patch(`${ORG}/departments/${top.id}`, {
        expectedVersion: 1,
        parentId: top.id,
      })
      self.assertStatus(422)
      const children = await as(client, s).get(`${ORG}/departments?parentId=${top.id}`)
      assert.deepEqual(
        children.body().data.map((d: any) => d.code),
        ['FIN']
      )

      const depB = (
        await as(client, s).post(`${ORG}/departments`, {
          code: 'DB',
          name: 'Dep B',
          legalEntityId: b.id,
        })
      ).body().data
      const ccWrongDep = await as(client, s).post(`${ORG}/cost-centers`, {
        code: 'CC1',
        name: 'Centro',
        legalEntityId: a.id,
        departmentId: depB.id,
      })
      ccWrongDep.assertStatus(422)
      const cc = (
        await as(client, s).post(`${ORG}/cost-centers`, {
          code: 'CC1',
          name: 'Centro',
          legalEntityId: a.id,
          departmentId: mid.id,
        })
      ).body().data
      // Mesmo código noutra entidade legal é permitido; na mesma não.
      ;(
        await as(client, s).post(`${ORG}/cost-centers`, {
          code: 'CC1',
          name: 'Centro B',
          legalEntityId: b.id,
        })
      ).assertStatus(201)
      const dup = await as(client, s).post(`${ORG}/cost-centers`, {
        code: 'CC1',
        name: 'Outro centro',
        legalEntityId: a.id,
      })
      dup.assertStatus(409)
      const child = (
        await as(client, s).post(`${ORG}/cost-centers`, {
          code: 'CC2',
          name: 'Filho',
          legalEntityId: a.id,
          parentId: cc.id,
        })
      ).body().data
      const ccCycle = await as(client, s).patch(`${ORG}/cost-centers/${cc.id}`, {
        expectedVersion: 1,
        parentId: child.id,
      })
      ccCycle.assertStatus(422)
      const moveLe = await as(client, s).patch(`${ORG}/cost-centers/${cc.id}`, {
        expectedVersion: 1,
        legalEntityId: b.id,
      })
      moveLe.assertStatus(422)
      moveLe.assertBodyContains({ error: { details: [{ code: 'IMMUTABLE' }] } })
    })

    test('concorrência: duas mudanças de pai em simultâneo não formam um ciclo', async ({
      client,
      assert,
    }) => {
      const s = await adminSession(client)
      const le = await legalEntity(client, s)
      const make = async (code: string) =>
        (
          await as(client, s).post(`${ORG}/departments`, {
            code,
            name: `Dep ${code}`,
            legalEntityId: le.id,
          })
        ).body().data
      const a = await make('DA')
      const b = await make('DB')
      const [first, second] = await Promise.all([
        as(client, s).patch(`${ORG}/departments/${a.id}`, { expectedVersion: 1, parentId: b.id }),
        as(client, s).patch(`${ORG}/departments/${b.id}`, { expectedVersion: 1, parentId: a.id }),
      ])
      assert.sameMembers([first.status(), second.status()], [200, 422])
    })

    test('cargos: nível 1–20, departamento existente, campos desconhecidos ignorados', async ({
      client,
      assert,
    }) => {
      const s = await adminSession(client)
      const bad = await as(client, s).post(`${ORG}/positions`, {
        code: 'P1',
        name: 'Técnico',
        level: 30,
      })
      bad.assertStatus(422)
      const ghost = await as(client, s).post(`${ORG}/positions`, {
        code: 'P1',
        name: 'Técnico',
        departmentId: '00000000-0000-4000-8000-000000000000',
      })
      ghost.assertStatus(422)
      const ok = await as(client, s).post(`${ORG}/positions`, {
        code: 'P1',
        name: 'Técnico',
        level: 4,
        jobFamily: 'Finanças',
        tenantId: '00000000-0000-4000-8000-000000000000',
        version: 99,
      })
      ok.assertStatus(201)
      assert.deepInclude(ok.body().data, { level: 4, jobFamily: 'Finanças', version: 1 })
      ;(await as(client, s).get(`${ORG}/unknown-kind`)).assertStatus(404)
    })

    test('permissões: leitura e gestão separadas; outro tenant não vê nem referencia', async ({
      client,
    }) => {
      const s = await adminSession(client, 'ORGA')
      const reader = await createRole(client, s, 'leitor_org', ['organization.read'])
      const r = await memberWithRoles(client, s, [reader.id])
      const le = await legalEntity(client, s)
      ;(await as(client, r.session).get(`${ORG}/legal-entities`)).assertStatus(200)
      ;(
        await as(client, r.session).post(`${ORG}/branches`, {
          code: 'F',
          name: 'Filial',
          legalEntityId: le.id,
        })
      ).assertStatus(403)

      const other = await adminSession(client, 'ORGB')
      ;(await as(client, other).get(`${ORG}/legal-entities/${le.id}`)).assertStatus(404)
      const cross = await as(client, other).post(`${ORG}/branches`, {
        code: 'F',
        name: 'Filial',
        legalEntityId: le.id,
      })
      cross.assertStatus(422)
      cross.assertBodyContains({
        error: { details: [{ path: 'legalEntityId', code: 'NOT_FOUND' }] },
      })
    })
  }
)

test.group('rbac | âmbitos por entidade legal, filial e departamento', (group) => {
  group.each.setup(() => cleanDatabase())

  test('atribui com alvo; valida o alvo; o âmbito de departamento inclui os subdepartamentos', async ({
    client,
    assert,
  }) => {
    const s = await adminSession(client)
    const le = await legalEntity(client, s)
    const top = (
      await as(client, s).post(`${ORG}/departments`, {
        code: 'DIR',
        name: 'Direcção',
        legalEntityId: le.id,
      })
    ).body().data
    const sub = (
      await as(client, s).post(`${ORG}/departments`, {
        code: 'SUB',
        name: 'Sub',
        legalEntityId: le.id,
        parentId: top.id,
      })
    ).body().data
    const role = await createRole(client, s, 'leitor', ['members.read'])
    const m = await memberWithRoles(client, s, [])

    const noTarget = await as(client, s).post(
      `${ORG.replace('organization', 'members')}/${m.memberId}/roles`,
      {
        roleId: role.id,
        scopeType: 'DEPARTMENT',
      }
    )
    noTarget.assertStatus(422)
    noTarget.assertBodyContains({ error: { details: [{ code: 'SCOPE_TARGET_REQUIRED' }] } })
    const extraTarget = await as(client, s).post(`/api/v1/members/${m.memberId}/roles`, {
      roleId: role.id,
      scopeType: 'TENANT',
      scopeId: top.id,
    })
    extraTarget.assertStatus(422)
    const ghost = await as(client, s).post(`/api/v1/members/${m.memberId}/roles`, {
      roleId: role.id,
      scopeType: 'BRANCH',
      scopeId: '00000000-0000-4000-8000-000000000000',
    })
    ghost.assertStatus(422)
    ghost.assertBodyContains({ error: { details: [{ code: 'SCOPE_TARGET_NOT_FOUND' }] } })

    const assigned = await as(client, s).post(`/api/v1/members/${m.memberId}/roles`, {
      roleId: role.id,
      scopeType: 'DEPARTMENT',
      scopeId: top.id,
    })
    assigned.assertStatus(200)
    assert.deepInclude(assigned.body().data.roles[0], { scopeType: 'DEPARTMENT', scopeId: top.id })
    // Âmbito de departamento não abre as rotas de empresa (que exigem âmbito TENANT).
    ;(await as(client, m.session).get('/api/v1/members')).assertStatus(403)

    const { permissionScope } = await import('#modules/rbac/index')
    const { runInTenant } = await import('#modules/tenancy/index')
    const context = {
      tenantId: s.tenantId,
      userId: 'teste',
      membershipId: m.memberId,
      requestId: 't',
    }
    const resolved = await runInTenant(context, (scope) => permissionScope(scope, 'members.read'))
    assert.isFalse(resolved.tenant)
    assert.sameMembers([...resolved.departmentIds], [top.id, sub.id])
    const none = await runInTenant(context, (scope) => permissionScope(scope, 'roles.read'))
    assert.equal(none.departmentIds.size, 0)
  })
})
