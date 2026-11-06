import { test } from '@japa/runner'
import { as, cleanDatabase, createRole, memberWithRoles } from '#tests/support/fixtures'
import { ledger as setupLedger, ok } from '#tests/support/accounting'

const A = '/api/v1/accounting'
const FA = `${A}/fixed-assets`

/** Empresa com plano para activos (113 equipamento, 118 amortizações, 66 gasto, 68 perda, 78 ganho) e uma classe. */
async function setup(client: any) {
  const L = await setupLedger(client)
  const account = async (code: string, level: string, nature: string, parentId: string | null) =>
    ok(
      await L.api.post(`${A}/accounts`, {
        chartId: L.chart.id,
        code,
        name: `Conta ${code}`,
        level,
        nature,
        parentId,
        ...(level === 'CLASS' ? {} : { postable: true }),
      })
    )
  const equipment = await account('113', 'SUBACCOUNT', 'ASSET', L.c11.id)
  const accumulated = await account('118', 'SUBACCOUNT', 'ASSET', L.c11.id)
  const c6 = await account('6', 'CLASS', 'EXPENSE', null)
  const expense = await account('66', 'ACCOUNT', 'EXPENSE', c6.id)
  const loss = await account('68', 'ACCOUNT', 'EXPENSE', c6.id)
  const gain = await account('78', 'ACCOUNT', 'REVENUE', L.c7.id)
  const cc = async (code: string) =>
    ok(
      await L.api.post('/api/v1/organization/cost-centers', {
        code,
        name: `Centro ${code}`,
        legalEntityId: L.le.id,
      })
    )
  const [cc1, cc2] = [await cc('ADM'), await cc('FAB')]
  const cls = ok(
    await L.api.post(`${A}/fixed-asset-classes`, {
      legalEntityId: L.le.id,
      code: 'EQ',
      name: 'Equipamento',
      method: 'STRAIGHT_LINE',
      usefulLifeMonths: 36,
      journalId: L.journal.id,
      assetAccountId: equipment.id,
      accumulatedAccountId: accumulated.id,
      expenseAccountId: expense.id,
      gainAccountId: gain.id,
      lossAccountId: loss.id,
    })
  )
  return { ...L, equipment, accumulated, expense, loss, gain, cc1, cc2, cls }
}

test.group('contabilidade | activos fixos', (group) => {
  group.each.setup(() => cleanDatabase())

  test('classe: contas movimentáveis da entidade, diário, método e coeficiente', async ({
    client,
    assert,
  }) => {
    const L = await setup(client)
    const bad = await L.api.post(`${A}/fixed-asset-classes`, {
      legalEntityId: L.le.id,
      code: 'X',
      name: 'Errada',
      method: 'DECLINING_BALANCE',
      usefulLifeMonths: 0,
      journalId: L.journal.id,
      assetAccountId: L.c11.id,
      accumulatedAccountId: L.accumulated.id,
      expenseAccountId: L.expense.id,
      gainAccountId: L.gain.id,
      lossAccountId: L.loss.id,
    })
    assert.equal(bad.status(), 422)
    const paths = bad.body().error.details.map((d: any) => d.path)
    assert.includeMembers(paths, ['usefulLifeMonths', 'decliningFactor', 'assetAccountId'])
    const dup = await L.api.post(`${A}/fixed-asset-classes`, {
      ...L.cls,
      id: undefined,
      version: undefined,
    })
    assert.equal(dup.status(), 409)
    assert.equal(dup.body().error.code, 'CLASS_CODE_TAKEN')
    const list = await L.api.get(`${A}/fixed-asset-classes?legalEntityId=${L.le.id}`)
    assert.equal(list.body().meta.total, 1)
  })

  test('ciclo completo: aquisição, transferência, depreciação, abate, anulações e mapa', async ({
    client,
    assert,
  }) => {
    const L = await setup(client)
    const base = {
      classId: L.cls.id,
      name: 'Torno CNC',
      serialNumber: 'SN-1',
      supplierName: 'Fornecedor X',
      acquisitionDocument: 'FT 2026/15',
      acquisitionDate: '2026-01-15',
      cost: '3600.00',
      location: 'Armazém',
      costCenterId: L.cc1.id,
    }
    const asset = ok(await L.api.post(FA, { ...base, number: 'AF-001' }))
    assert.equal(asset.status, 'DRAFT')
    assert.equal(asset.cost, '3600.00')
    assert.equal(asset.depreciationStart, '2026-01')
    assert.equal(asset.usefulLifeMonths, 36)
    assert.lengthOf(asset.schedule, 36)
    assert.equal(asset.schedule[0].amount, '100.00')

    // Bloqueio de duplicados: mesmo n.º de série (sem distinguir maiúsculas) ou mesmo n.º de inventário.
    const dupSerial = await L.api.post(FA, { ...base, number: 'AF-002', serialNumber: 'sn-1' })
    assert.equal(dupSerial.status(), 409)
    assert.equal(dupSerial.body().error.code, 'DUPLICATE_SERIAL')
    const dupNumber = await L.api.post(FA, { ...base, number: 'AF-001', serialNumber: null })
    assert.equal(dupNumber.body().error.code, 'ASSET_NUMBER_TAKEN')

    // Por contabilizar, nada a depreciar.
    const none = await L.api.post(`${FA}/depreciation/run`, {
      legalEntityId: L.le.id,
      upTo: '2026-03',
    })
    assert.equal(none.status(), 409)
    assert.equal(none.body().error.code, 'NOTHING_TO_DEPRECIATE')

    const acquired = ok(
      await L.api.post(`${FA}/${asset.id}/acquire`, {
        expectedVersion: asset.version,
        counterpartAccountId: L.cash.id,
      }),
      200
    )
    assert.equal(acquired.status, 'ACTIVE')
    assert.match(acquired.acquisitionEntryNumber, /^DG\//)
    const again = await L.api.post(`${FA}/${asset.id}/acquire`, {
      expectedVersion: acquired.version,
      counterpartAccountId: L.cash.id,
    })
    assert.equal(again.body().error.code, 'INVALID_STATUS')
    // Já contabilizado: o custo não muda e o lançamento só se estorna pela ficha.
    const immutable = await L.api.patch(`${FA}/${asset.id}`, {
      expectedVersion: acquired.version,
      cost: '5000.00',
    })
    assert.equal(immutable.status(), 422)
    const generic = await L.api.post(`${A}/entries/${acquired.acquisitionEntryId}/reverse`, {
      date: '2026-01-31',
    })
    assert.equal(generic.status(), 409)
    assert.equal(generic.body().error.code, 'MANAGED_BY_FIXED_ASSETS')

    const moved = ok(
      await L.api.post(`${FA}/${asset.id}/transfer`, {
        expectedVersion: acquired.version,
        date: '2026-03-10',
        location: 'Fábrica',
        costCenterId: L.cc2.id,
      }),
      200
    )
    assert.equal(moved.location, 'Fábrica')

    const preview = ok(
      await L.api.get(`${FA}/depreciation/preview?legalEntityId=${L.le.id}&upTo=2026-03`),
      200
    )
    assert.equal(preview.total, '300.00')
    assert.deepEqual(
      preview.rows.map((r: any) => [r.month, r.costCenterId]),
      [
        ['2026-01', L.cc1.id],
        ['2026-02', L.cc1.id],
        ['2026-03', L.cc2.id],
      ]
    )
    const run = ok(
      await L.api.post(`${FA}/depreciation/run`, { legalEntityId: L.le.id, upTo: '2026-03' }),
      200
    )
    assert.lengthOf(run.entries, 3)
    const twice = await L.api.post(`${FA}/depreciation/run`, {
      legalEntityId: L.le.id,
      upTo: '2026-03',
    })
    assert.equal(twice.body().error.code, 'NOTHING_TO_DEPRECIATE')

    // Concorrência: duas execuções ao mesmo tempo para abril — uma deprecia, a outra não encontra nada.
    const [r1, r2] = await Promise.all([
      L.api.post(`${FA}/depreciation/run`, { legalEntityId: L.le.id, upTo: '2026-04' }),
      L.api.post(`${FA}/depreciation/run`, { legalEntityId: L.le.id, upTo: '2026-04' }),
    ])
    assert.sameMembers([r1.status(), r2.status()], [200, 409])

    // A transferência não pode cair num mês já depreciado.
    let current = ok(await L.api.get(`${FA}/${asset.id}`), 200)
    const late = await L.api.post(`${FA}/${asset.id}/transfer`, {
      expectedVersion: current.version,
      date: '2026-04-20',
      location: 'Outro',
    })
    assert.equal(late.body().error.details[0].code, 'MONTH_DEPRECIATED')
    assert.equal(current.accumulated, '400.00')
    assert.equal(current.bookValue, '3200.00')
    assert.equal(current.schedule.filter((r: any) => r.posted).length, 4)

    // A analítica reparte as depreciações pelos centros em vigor em cada mês.
    const fy = L.year.id
    const an = ok(
      await L.api.get(`${A}/analytics?fiscalYearId=${fy}&groupBy=costCenter&natures=EXPENSE`),
      200
    )
    const byCenter = Object.fromEntries(an.rows.map((r: any) => [r.key, r.debit]))
    assert.equal(byCenter[L.cc1.id], '200.00')
    assert.equal(byCenter[L.cc2.id], '200.00')
    assert.isTrue(an.consistent)

    // Abate em junho: falta maio.
    const early = await L.api.post(`${FA}/${asset.id}/dispose`, {
      expectedVersion: current.version,
      date: '2026-06-10',
      proceeds: '3500.00',
      proceedsAccountId: L.cash.id,
      reason: 'Venda',
    })
    assert.equal(early.body().error.details[0].code, 'DEPRECIATION_PENDING')
    ok(await L.api.post(`${FA}/depreciation/run`, { legalEntityId: L.le.id, upTo: '2026-05' }), 200)
    current = ok(await L.api.get(`${FA}/${asset.id}`), 200)
    const disposed = ok(
      await L.api.post(`${FA}/${asset.id}/dispose`, {
        expectedVersion: current.version,
        date: '2026-06-10',
        proceeds: '3500.00',
        proceedsAccountId: L.cash.id,
        reason: 'Venda',
      }),
      200
    )
    assert.equal(disposed.status, 'DISPOSED')
    assert.equal(disposed.bookValue, '0.00')
    const sale = ok(await L.api.get(`${A}/entries/${disposed.disposalEntryId}`), 200)
    const line = (id: string) => sale.lines.find((l: any) => l.accountId === id)
    assert.equal(line(L.equipment.id).credit, '3600.00')
    assert.equal(line(L.accumulated.id).debit, '500.00')
    assert.equal(line(L.cash.id).debit, '3500.00')
    assert.equal(line(L.gain.id).credit, '400.00') // 3500 − (3600 − 500)
    assert.equal(sale.status, 'POSTED')

    // Abatido: não deprecia mais e as depreciações não se anulam sem anular o abate.
    const after = await L.api.post(`${FA}/depreciation/run`, {
      legalEntityId: L.le.id,
      upTo: '2026-07',
    })
    assert.equal(after.body().error.code, 'NOTHING_TO_DEPRECIATE')
    const blocked = await L.api.post(`${FA}/depreciation/undo`, {
      legalEntityId: L.le.id,
      month: '2026-05',
      date: '2026-06-30',
    })
    assert.equal(blocked.body().error.code, 'ASSET_DISPOSED')

    const back = ok(
      await L.api.post(`${FA}/${asset.id}/reverse-disposal`, {
        expectedVersion: disposed.version,
        date: '2026-06-30',
        reason: 'Venda anulada',
      }),
      200
    )
    assert.equal(back.status, 'ACTIVE')
    const notLast = await L.api.post(`${FA}/depreciation/undo`, {
      legalEntityId: L.le.id,
      month: '2026-04',
      date: '2026-06-30',
    })
    assert.equal(notLast.body().error.code, 'LATER_MONTHS')
    const undone = ok(
      await L.api.post(`${FA}/depreciation/undo`, {
        legalEntityId: L.le.id,
        month: '2026-05',
        date: '2026-06-30',
      }),
      200
    )
    assert.lengthOf(undone.reversals, 1)
    const hasDep = await L.api.post(`${FA}/${asset.id}/reverse-acquisition`, {
      expectedVersion: back.version,
      date: '2026-06-30',
    })
    assert.equal(hasDep.body().error.code, 'HAS_DEPRECIATION')

    const map = ok(await L.api.get(`${FA}/depreciation-map?fiscalYearId=${fy}`), 200)
    assert.lengthOf(map.rows, 1)
    assert.include(map.rows[0], {
      number: 'AF-001',
      cost: '3600.00',
      opening: '0.00',
      period: '400.00',
      closing: '400.00',
      bookValue: '3200.00',
      forecast: '1200.00',
    })
    assert.equal(map.totals.period, '400.00')
    assert.equal(map.classes[0].code, 'EQ')

    const history = ok(await L.api.get(`${FA}/${asset.id}`), 200)
    assert.deepEqual(
      history.movements.map((m: any) => m.type),
      ['ACQUISITION', 'TRANSFER', 'DISPOSAL', 'DISPOSAL_REVERSED']
    )
  })

  test('validação, edição e eliminação de fichas por contabilizar', async ({ client, assert }) => {
    const L = await setup(client)
    const bad = await L.api.post(FA, {
      classId: L.cls.id,
      number: 'AF-9',
      name: 'Secretária',
      acquisitionDate: '2026-02-01',
      cost: '1000.00',
      residualValue: '1000.00',
      depreciationStart: '2026-01',
    })
    assert.equal(bad.status(), 422)
    assert.includeMembers(
      bad.body().error.details.map((d: any) => d.path),
      ['residualValue', 'depreciationStart']
    )
    const draft = ok(
      await L.api.post(FA, {
        classId: L.cls.id,
        number: 'AF-9',
        name: 'Secretária',
        acquisitionDate: '2026-02-01',
        cost: '1000.00',
        method: 'DECLINING_BALANCE',
        decliningFactor: '1.5',
        usefulLifeMonths: 60,
      })
    )
    assert.equal(draft.decliningFactor, '1.50')
    const edited = ok(
      await L.api.patch(`${FA}/${draft.id}`, {
        expectedVersion: draft.version,
        cost: '1200.00',
        method: 'STRAIGHT_LINE',
      }),
      200
    )
    assert.equal(edited.cost, '1200.00')
    assert.isNull(edited.decliningFactor)
    assert.equal(edited.schedule[0].amount, '20.00')
    const list = ok(await L.api.get(`${FA}?status=DRAFT&q=secret`), 200)
    assert.lengthOf(list, 1)
    assert.equal((await L.api.delete(`${FA}/${draft.id}`)).status(), 204)
    assert.equal((await L.api.get(`${FA}/${draft.id}`)).status(), 404)
  })

  test('permissões: consultar, gerir e contabilizar são separadas', async ({ client, assert }) => {
    const L = await setup(client)
    const asset = ok(
      await L.api.post(FA, {
        classId: L.cls.id,
        number: 'AF-1',
        name: 'Viatura',
        acquisitionDate: '2026-01-01',
        cost: '1200.00',
      })
    )
    const reader = await createRole(client, L.s, 'fa_read', ['fixed_assets.read'])
    const manager = await createRole(client, L.s, 'fa_manage', [
      'fixed_assets.read',
      'fixed_assets.manage',
    ])
    const r = as(client, (await memberWithRoles(client, L.s, [reader.id])).session)
    const m = as(client, (await memberWithRoles(client, L.s, [manager.id])).session)
    assert.equal((await r.get(`${FA}/${asset.id}`)).status(), 200)
    assert.equal(
      (await r.patch(`${FA}/${asset.id}`, { expectedVersion: 1, name: 'X' })).status(),
      403
    )
    assert.equal(
      (
        await m.patch(`${FA}/${asset.id}`, { expectedVersion: asset.version, name: 'Viatura 1' })
      ).status(),
      200
    )
    assert.equal(
      (
        await m.post(`${FA}/${asset.id}/acquire`, {
          expectedVersion: 2,
          counterpartAccountId: L.cash.id,
        })
      ).status(),
      403
    )
    assert.equal(
      (
        await m.post(`${FA}/depreciation/run`, { legalEntityId: L.le.id, upTo: '2026-01' })
      ).status(),
      403
    )
  })
})
