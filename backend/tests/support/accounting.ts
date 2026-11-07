import { as, signIn, tenantWithAdmin } from '#tests/support/fixtures'

const A = '/api/v1/accounting'

export const ok = (r: any, status = 201) => {
  if (r.status() !== status) throw new Error(`${r.status()} ${JSON.stringify(r.body())}`)
  return r.body().data
}

/** Empresa com entidade legal, série de lançamentos, plano (1 → 11 → 111, 7 → 71), exercício 2026 e diário. */
export async function ledger(client: any) {
  const { tenant, admin } = await tenantWithAdmin()
  const s = await signIn(client, admin.email, tenant.id)
  const api = as(client, s)
  const le = ok(
    await api.post('/api/v1/organization/legal-entities', {
      code: 'LE1',
      legalName: 'Entidade Um, Lda.',
      taxId: '5000000001',
      countryCode: 'AO',
      functionalCurrency: 'AOA',
    })
  )
  const series = ok(
    await api.post('/api/v1/document-series', {
      legalEntityId: le.id,
      documentType: 'JOURNAL',
      code: 'DG2026',
      prefix: 'DG/',
      padding: 4,
    })
  )
  const chart = ok(
    await api.post(`${A}/charts`, {
      legalEntityId: le.id,
      code: 'PC',
      name: 'Plano da Entidade Um',
      jurisdiction: 'ao',
      baseModel: 'Estrutura própria (a validar com o PGC em vigor)',
    })
  )
  const account = async (
    code: string,
    level: string,
    nature: string,
    parentId: string | null,
    extra = {}
  ) =>
    ok(
      await api.post(`${A}/accounts`, {
        chartId: chart.id,
        code,
        name: `Conta ${code}`,
        level,
        nature,
        parentId,
        ...extra,
      })
    )
  const c1 = await account('1', 'CLASS', 'ASSET', null)
  const c11 = await account('11', 'ACCOUNT', 'ASSET', c1.id)
  const cash = await account('111', 'SUBACCOUNT', 'ASSET', c11.id, { postable: true })
  const c7 = await account('7', 'CLASS', 'REVENUE', null)
  const sales = await account('71', 'ACCOUNT', 'REVENUE', c7.id, { postable: true })
  const year = ok(
    await api.post(`${A}/fiscal-years`, {
      legalEntityId: le.id,
      code: '2026',
      startDate: '2026-01-01',
      endDate: '2026-12-31',
    })
  )
  const journal = ok(
    await api.post(`${A}/journals`, {
      legalEntityId: le.id,
      code: 'DG',
      name: 'Diário geral',
      type: 'GENERAL',
      documentSeriesId: series.id,
    })
  )
  return { s, api, le, series, chart, c1, c11, cash, c7, sales, year, journal, adminId: admin.id }
}
