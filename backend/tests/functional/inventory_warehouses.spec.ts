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

const W = '/api/v1/inventory/warehouses'
const owner = () => db.connection('owner')
const ok = (r: any, status = 201) => {
  if (r.status() !== status) throw new Error(`${r.status()} ${JSON.stringify(r.body())}`)
  return r.body().data
}
const code = (r: any) => r.body().error?.code
const details = (r: any) => (r.body().error?.details ?? []).map((d: any) => d.code)

async function roleMember(
  client: any,
  admin: Session,
  roleCode: string,
  permissions: string[],
  scopeType = 'TENANT',
  scopeId?: string
) {
  const m = await memberWithRoles(client, admin, [])
  if (permissions.length) {
    const role = await createRole(client, admin, roleCode, permissions)
    ok(
      await as(client, admin).post(`/api/v1/members/${m.memberId}/roles`, {
        roleId: role.id,
        scopeType,
        ...(scopeId ? { scopeId } : {}),
      }),
      200
    )
  }
  return { api: as(client, m.session), memberId: m.memberId }
}

async function setup(client: any) {
  const { tenant, admin } = await tenantWithAdmin()
  const s = await signIn(client, admin.email, tenant.id)
  const api = as(client, s)
  const le = async (c: string, taxId: string) =>
    ok(
      await api.post('/api/v1/organization/legal-entities', {
        code: c,
        legalName: `Entidade ${c}, Lda.`,
        taxId,
        countryCode: 'AO',
        functionalCurrency: 'AOA',
      })
    )
  const leA = await le('LEA', '5000000811')
  const leB = await le('LEB', '5000000812')
  const branchA = ok(
    await api.post('/api/v1/organization/branches', {
      code: 'LDA',
      name: 'Luanda',
      legalEntityId: leA.id,
    })
  )
  const branchB = ok(
    await api.post('/api/v1/organization/branches', {
      code: 'BGL',
      name: 'Benguela',
      legalEntityId: leB.id,
    })
  )
  return { tenant, admin, s, api, leA, leB, branchA, branchB }
}

test.group('Inventário | armazéns (8.2)', (group) => {
  group.each.setup(() => cleanDatabase())

  test('armazém: validação, filial da mesma entidade, responsável, código e entidade fixos', async ({
    client,
    assert,
  }) => {
    const o = await setup(client)
    const boss = await memberWithRoles(client, o.s, [])
    assert.includeMembers(
      details(
        await o.api.post(W, { code: 'a b', name: 'X', warehouseType: 'NOPE', countryCode: 'AGO' })
      ),
      ['INVALID_CODE', 'REQUIRED', 'LENGTH', 'INVALID', 'INVALID_COUNTRY']
    )
    assert.include(
      details(
        await o.api.post(W, {
          code: 'ARM1',
          name: 'Armazém central',
          legalEntityId: o.leA.id,
          branchId: o.branchB.id,
          warehouseType: 'MAIN',
        })
      ),
      'OTHER_LEGAL_ENTITY'
    )
    let w = ok(
      await o.api.post(W, {
        code: 'arm1',
        name: 'Armazém central',
        legalEntityId: o.leA.id,
        branchId: o.branchA.id,
        managerMembershipId: boss.memberId,
        warehouseType: 'MAIN',
        addressLine: 'Rua 1',
        city: 'Luanda',
        countryCode: 'ao',
      })
    )
    assert.equal(w.code, 'ARM1')
    assert.equal(w.countryCode, 'AO')
    assert.equal(w.manager.name, 'Membro de Teste')
    assert.deepEqual(w.access, { read: true, operate: true, manage: true })
    assert.equal(
      code(
        await o.api.post(W, {
          code: 'ARM1',
          name: 'Outro',
          legalEntityId: o.leA.id,
          warehouseType: 'STORE',
        })
      ),
      'CODE_TAKEN'
    )
    assert.include(
      details(
        await o.api.patch(`${W}/${w.id}`, { legalEntityId: o.leB.id, expectedVersion: w.version })
      ),
      'FIXED'
    )
    assert.equal(
      (await o.api.patch(`${W}/${w.id}`, { name: 'X', expectedVersion: 99 })).status(),
      409
    )
    w = ok(
      await o.api.patch(`${W}/${w.id}`, {
        name: 'Armazém Central',
        branchId: null,
        expectedVersion: w.version,
      }),
      200
    )
    assert.isNull(w.branch)
    const a = await owner().rawQuery(
      `select action, changes::text as c from audit_events where entity_type = 'warehouse' and entity_id = ? order by created_at`,
      [w.id]
    )
    assert.deepEqual(
      a.rows.map((x: any) => x.action),
      ['inventory.warehouse.created', 'inventory.warehouse.updated']
    )
  })

  test('localizações: zona → corredor → estante → posição, séries, caminho fixo e inactivação ordenada', async ({
    client,
    assert,
  }) => {
    const o = await setup(client)
    const w = ok(
      await o.api.post(W, {
        code: 'ARM',
        name: 'Armazém',
        legalEntityId: o.leA.id,
        warehouseType: 'MAIN',
      })
    )
    const L = (body: Record<string, unknown>) => o.api.post(`${W}/${w.id}/locations`, body)
    assert.include(details(await L({ code: 'a-1' })), 'INVALID_CODE')
    let d = ok(await L({ code: 'a', name: 'Zona A' }))
    const zone = d.locations[0]
    assert.deepEqual([zone.level, zone.pathCode, zone.holdsStock], ['ZONE', 'A', false])
    d = ok(await L({ parentId: zone.id, code: '01' }))
    const aisle = d.locations.find((l: any) => l.pathCode === 'A-01')
    assert.equal(aisle.level, 'AISLE')
    d = ok(await L({ parentId: aisle.id, code: 'E1' }))
    const rack = d.locations.find((l: any) => l.pathCode === 'A-01-E1')
    d = ok(await L({ parentId: rack.id, series: { prefix: 'P', from: 1, to: 20, width: 2 } }))
    const bins = d.locations.filter((l: any) => l.level === 'BIN')
    assert.lengthOf(bins, 20)
    assert.equal(bins[0].pathCode, 'A-01-E1-P01')
    assert.isTrue(bins[0].holdsStock)
    // Repetidos, demasiado fundo, séries inválidas.
    assert.equal(
      code(await L({ parentId: rack.id, series: { prefix: 'P', from: 18, to: 22, width: 2 } })),
      'LOCATION_EXISTS'
    )
    assert.include(details(await L({ parentId: bins[0].id, code: 'X' })), 'TOO_DEEP')
    assert.include(
      details(await L({ parentId: rack.id, series: { prefix: 'P', from: 1, to: 500, width: 3 } })),
      'INVALID'
    )
    // Código e superior fixos (também na base).
    assert.include(
      details(
        await o.api.patch(`/api/v1/inventory/warehouse-locations/${bins[0].id}`, {
          code: 'Z',
          expectedVersion: 1,
        })
      ),
      'FIXED'
    )
    await assert.rejects(() =>
      owner().rawQuery(`update warehouse_locations set code = 'Z' where id = ?`, [bins[0].id])
    )
    await assert.rejects(() =>
      owner().rawQuery(`delete from warehouse_locations where id = ?`, [bins[0].id])
    )
    // Inactivar de baixo para cima.
    assert.equal(
      code(
        await o.api.patch(`/api/v1/inventory/warehouse-locations/${rack.id}`, {
          status: 'INACTIVE',
          expectedVersion: rack.version,
        })
      ),
      'ACTIVE_CHILDREN'
    )
    d = ok(
      await o.api.patch(`/api/v1/inventory/warehouse-locations/${bins[0].id}`, {
        status: 'INACTIVE',
        name: 'Avariada',
        expectedVersion: bins[0].version,
      }),
      200
    )
    assert.equal(d.locations.find((l: any) => l.id === bins[0].id).status, 'INACTIVE')
    assert.include(details(await L({ parentId: bins[0].id, code: 'X' })), 'INACTIVE')
  })

  test('acesso: âmbito por entidade/filial, armazém restrito com lista, gestão separada da consulta', async ({
    client,
    assert,
  }) => {
    const o = await setup(client)
    const mk = async (c: string, le: any, extra: Record<string, unknown> = {}) =>
      ok(
        await o.api.post(W, {
          code: c,
          name: `Armazém ${c}`,
          legalEntityId: le.id,
          warehouseType: 'MAIN',
          ...extra,
        })
      )
    const wa = await mk('WA', o.leA, { branchId: o.branchA.id })
    const wb = await mk('WB', o.leB)
    const secret = await mk('WR', o.leA, { accessMode: 'RESTRICTED' })
    // Leitor só da entidade A.
    const readerA = await roleMember(
      client,
      o.s,
      'ler_a',
      ['inventory.read'],
      'LEGAL_ENTITY',
      o.leA.id
    )
    let list = ok(await readerA.api.get(W), 200)
    assert.sameMembers(
      list.map((x: any) => x.code),
      ['WA']
    )
    assert.equal((await readerA.api.get(`${W}/${wb.id}`)).status(), 404)
    assert.equal((await readerA.api.get(`${W}/${secret.id}`)).status(), 404)
    assert.equal(
      (
        await readerA.api.post(W, {
          code: 'X1',
          name: 'Xx',
          legalEntityId: o.leA.id,
          warehouseType: 'MAIN',
        })
      ).status(),
      403
    )
    // Gestor da filial de Luanda: gere WA (da filial) mas não cria armazéns na entidade sem filial.
    const branchMgr = await roleMember(
      client,
      o.s,
      'gere_filial',
      ['inventory.warehouses.manage'],
      'BRANCH',
      o.branchA.id
    )
    assert.equal(
      (
        await branchMgr.api.post(W, {
          code: 'X2',
          name: 'Xx',
          legalEntityId: o.leA.id,
          warehouseType: 'MAIN',
        })
      ).status(),
      403
    )
    ok(
      await branchMgr.api.post(W, {
        code: 'X3',
        name: 'Xx',
        legalEntityId: o.leA.id,
        branchId: o.branchA.id,
        warehouseType: 'STORE',
      })
    )
    const got = ok(await branchMgr.api.get(`${W}/${wa.id}`), 200)
    assert.isTrue(got.access.manage)
    assert.equal(
      (
        await branchMgr.api.patch(`${W}/${wa.id}`, { branchId: null, expectedVersion: got.version })
      ).status(),
      403
    )
    // Armazém restrito: só quem está na lista (consultar/operar) e quem o gere.
    ok(
      await o.api.put(`${W}/${secret.id}/access`, {
        membershipId: readerA.memberId,
        level: 'VIEW',
      }),
      200
    )
    list = ok(await readerA.api.get(W), 200)
    assert.sameMembers(
      list.map((x: any) => x.code),
      ['WA', 'WR', 'X3']
    )
    const seen = ok(await readerA.api.get(`${W}/${secret.id}`), 200)
    assert.deepEqual(seen.access, { read: true, operate: false, manage: false })
    assert.isNull(seen.members) // a lista só para quem gere
    assert.equal(
      (
        await readerA.api.put(`${W}/${secret.id}/access`, {
          membershipId: readerA.memberId,
          level: 'OPERATE',
        })
      ).status(),
      403
    )
    const full = ok(
      await o.api.put(`${W}/${secret.id}/access`, {
        membershipId: readerA.memberId,
        level: 'OPERATE',
      }),
      200
    )
    assert.deepEqual(
      full.members.map((m: any) => m.level),
      ['OPERATE']
    )
    ok(
      await o.api.put(`${W}/${secret.id}/access`, { membershipId: readerA.memberId, level: null }),
      200
    )
    assert.equal((await readerA.api.get(`${W}/${secret.id}`)).status(), 404)
    // Candidatos (membros activos) só para quem gere.
    assert.equal((await readerA.api.get(`${W}/candidates`)).status(), 403)
    assert.isAbove(ok(await o.api.get(`${W}/candidates`), 200).length, 1)
  })
})
