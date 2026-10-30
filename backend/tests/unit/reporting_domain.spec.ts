import { test } from '@japa/runner'
import {
  applyGlobalFilters,
  buildQuery,
  csvCell,
  csvLine,
  normalizeWidget,
  searchTerms,
  snippetOf,
  validateQuery,
  visibleFields,
  type DatasetDefinition,
  type ReportQuery,
} from '#modules/reporting/domain/reporting'

const DATASET: DatasetDefinition = {
  code: 'vendas',
  name: 'Vendas',
  description: 'Teste',
  permission: 'invoice.read',
  from: `(select * from invoices where tenant_id = :tenant) d`,
  where: `d.status = 'ISSUED'`,
  fields: [
    { code: 'number', label: 'Número', type: 'string', expression: 'd.number' },
    { code: 'kind', label: 'Tipo', type: 'enum', expression: 'd.kind', enumValues: ['A', 'B'] },
    { code: 'issued_on', label: 'Data', type: 'date', expression: 'd.issued_on' },
    { code: 'currency', label: 'Moeda', type: 'string', expression: 'd.currency' },
    { code: 'total', label: 'Total', type: 'decimal', expression: 'd.total' },
    { code: 'lines', label: 'Linhas', type: 'integer', expression: 'd.lines' },
    {
      code: 'secret',
      label: 'Segredo',
      type: 'decimal',
      expression: 'd.secret',
      permission: 'x.y',
    },
  ],
  defaultSort: 'd.issued_on desc, d.id',
  documentation: [],
}

const NONE: ReadonlySet<string> = new Set()
const HIDDEN: ReadonlySet<string> = new Set(['secret'])
const codes = (r: { issues: { code: string }[] }) => r.issues.map((i) => i.code)

test.group('relatórios | validação da consulta', () => {
  test('aceita detalhe, agrupamento e medidas dos campos do dataset', ({ assert }) => {
    const detail = validateQuery(DATASET, { select: ['number', 'total'] }, NONE)
    assert.deepEqual(detail.value?.select, ['number', 'total'])
    const grouped = validateQuery(
      DATASET,
      {
        groupBy: ['currency'],
        measures: [
          { fn: 'sum', field: 'total', alias: 'soma' },
          { fn: 'count', alias: 'n' },
        ],
        sort: [{ field: 'soma', dir: 'desc' }],
      },
      NONE
    )
    assert.isOk(grouped.value)
  })

  test('campos desconhecidos ou ocultos são recusados em filtros, grupos, medidas e ordenação', ({
    assert,
  }) => {
    for (const query of [
      { select: ['nao_existe'] },
      { groupBy: ['secret'], measures: [{ fn: 'count', alias: 'n' }] },
      { select: ['number'], filters: [{ field: 'secret', op: 'gt', value: '1' }] },
      { measures: [{ fn: 'sum', field: 'secret', alias: 'n' }] },
      { select: ['number'], filters: [{ field: 'drop table', op: 'eq', value: 'x' }] },
    ]) {
      const result = validateQuery(DATASET, query, HIDDEN)
      assert.include(codes(result), 'FIELD_NOT_ALLOWED', JSON.stringify(query))
    }
  })

  test('em detalhe, um campo oculto sai da lista de colunas em vez de falhar', ({ assert }) => {
    const result = validateQuery(DATASET, { select: ['number', 'secret'] }, HIDDEN)
    assert.deepEqual(result.value?.select, ['number'])
    const only = validateQuery(DATASET, { select: ['secret'] }, HIDDEN)
    assert.include(codes(only), 'REQUIRED')
  })

  test('operadores e valores respeitam o tipo do campo', ({ assert }) => {
    const bad = (filter: unknown) =>
      codes(validateQuery(DATASET, { select: ['number'], filters: [filter] }, NONE))
    assert.include(bad({ field: 'total', op: 'contains', value: 'x' }), 'INVALID')
    assert.include(bad({ field: 'total', op: 'gt', value: 12.5 }), 'INVALID_VALUE')
    assert.include(bad({ field: 'issued_on', op: 'eq', value: '2026-02-30' }), 'INVALID_VALUE')
    assert.include(bad({ field: 'kind', op: 'eq', value: 'C' }), 'INVALID_VALUE')
    assert.include(bad({ field: 'lines', op: 'eq', value: '3' }), 'INVALID_VALUE')
    assert.include(bad({ field: 'number', op: 'in', value: [] }), 'INVALID_VALUE')
    assert.include(
      bad({ field: 'issued_on', op: 'between', value: ['2026-01-01'] }),
      'INVALID_VALUE'
    )
    assert.include(bad({ field: 'number', op: ';--', value: 'x' }), 'INVALID')
    const ok = validateQuery(
      DATASET,
      {
        select: ['number'],
        filters: [
          { field: 'total', op: 'gte', value: '10.50' },
          { field: 'issued_on', op: 'between', value: ['2026-01-01', '2026-01-31'] },
          { field: 'kind', op: 'in', value: ['A', 'B'] },
          { field: 'number', op: 'contains', value: 'FT' },
        ],
      },
      NONE
    )
    assert.isOk(ok.value)
  })

  test('medidas: função certa para o tipo, alias válido e único, e detalhe só do agrupado', ({
    assert,
  }) => {
    const bad = (measure: unknown, extra: Record<string, unknown> = {}) =>
      codes(validateQuery(DATASET, { measures: [measure], ...extra }, NONE))
    assert.include(bad({ fn: 'sum', field: 'number', alias: 'x' }), 'INVALID')
    assert.include(bad({ fn: 'avg', field: 'issued_on', alias: 'x' }), 'INVALID')
    assert.include(bad({ fn: 'median', field: 'total', alias: 'x' }), 'INVALID')
    assert.include(bad({ fn: 'count', alias: 'Total Geral' }), 'INVALID')
    assert.include(bad({ fn: 'count', alias: 'total' }), 'INVALID')
    assert.include(bad({ fn: 'count', alias: 'n' }, { select: ['number'] }), 'SELECT_NOT_GROUPED')
    assert.include(
      codes(
        validateQuery(
          DATASET,
          { measures: [{ fn: 'count', alias: 'n' }], sort: [{ field: 'total', dir: 'asc' }] },
          NONE
        )
      ),
      'INVALID'
    )
    const dup = codes(
      validateQuery(
        DATASET,
        {
          measures: [
            { fn: 'count', alias: 'n' },
            { fn: 'sum', field: 'total', alias: 'n' },
          ],
        },
        NONE
      )
    )
    assert.include(dup, 'INVALID')
  })
})

test.group('relatórios | SQL declarativo', () => {
  const build = (query: Partial<ReportQuery>, page = { limit: 10, offset: 0 }) => {
    const { value } = validateQuery(DATASET, query, NONE)
    return buildQuery(DATASET, value as ReportQuery, 't-1', page)
  }

  test('os valores vão por parâmetros e nunca no texto do SQL', ({ assert }) => {
    const built = build({
      select: ['number'],
      filters: [
        { field: 'number', op: 'contains', value: "x'; drop table users; --" },
        { field: 'total', op: 'between', value: ['1', '2'] },
        { field: 'kind', op: 'in', value: ['A', 'B'] },
      ],
    })
    assert.notInclude(built.sql, 'drop table')
    assert.notInclude(built.sql, "x'")
    assert.include(Object.values(built.bindings), "%x'; drop table users; --%")
    assert.equal(built.bindings['tenant'], 't-1')
    assert.include(built.sql, `d.status = 'ISSUED'`)
    assert.include(built.sql, 'cast(:p')
    // Os nomes `:p…` do SQL existem todos nos parâmetros.
    for (const name of built.sql.match(/:p\d+/g) ?? [])
      assert.property(built.bindings, name.slice(1))
  })

  test('o texto de pesquisa escapa % e _ (são literais)', ({ assert }) => {
    const built = build({
      select: ['number'],
      filters: [{ field: 'number', op: 'contains', value: '100%_x' }],
    })
    assert.include(Object.values(built.bindings), '%100\\%\\_x%')
  })

  test('decimais e datas saem como texto; agregados somam em texto e contam em inteiro', ({
    assert,
  }) => {
    const detail = build({ select: ['issued_on', 'total', 'lines'] })
    assert.include(detail.sql, `to_char(d.issued_on, 'YYYY-MM-DD')`)
    assert.include(detail.sql, 'cast(d.total as text)')
    const grouped = build({
      groupBy: ['currency'],
      measures: [
        { fn: 'sum', field: 'total', alias: 'soma' },
        { fn: 'avg', field: 'total', alias: 'media' },
        { fn: 'count', alias: 'n' },
        { fn: 'max', field: 'issued_on', alias: 'ultima' },
      ],
    })
    assert.include(grouped.sql, 'cast(sum((d.total)) as text)')
    assert.include(grouped.sql, 'cast(round(avg((d.total)), 4) as text)')
    assert.include(grouped.sql, 'cast(count(*) as int)')
    assert.include(grouped.sql, `to_char(max((d.issued_on)), 'YYYY-MM-DD')`)
    assert.include(grouped.sql, 'group by (d.currency)')
    assert.deepEqual(
      grouped.columns.map((c) => c.code),
      ['currency', 'soma', 'media', 'n', 'ultima']
    )
  })

  test('sem agrupamento, uma medida dá uma só linha e a contagem é 1', ({ assert }) => {
    const kpi = build({ measures: [{ fn: 'sum', field: 'total', alias: 'soma' }] })
    assert.notInclude(kpi.sql, 'group by')
    assert.include(kpi.countSql, 'cast(1 as int)')
  })

  test('a ordenação por omissão é determinística e a pedida só usa colunas do resultado', ({
    assert,
  }) => {
    assert.include(build({ select: ['number'] }).sql, 'order by d.issued_on desc, d.id')
    assert.include(
      build({
        groupBy: ['currency'],
        measures: [{ fn: 'count', alias: 'n' }],
        sort: [{ field: 'n', dir: 'desc' }],
      }).sql,
      'order by "n" desc'
    )
    assert.notInclude(build({ select: ['number'] }).sql, '::')
  })
})

test.group('relatórios | CSV, painéis e pesquisa', () => {
  test('o CSV neutraliza fórmulas e protege vírgulas, aspas e quebras de linha', ({ assert }) => {
    assert.equal(csvCell('=HYPERLINK("http://x")'), `"'=HYPERLINK(""http://x"")"`)
    for (const cell of ['+1+1', '@SUM(A1)', '-2+3', '\tx', '\rx', '=1']) {
      assert.isTrue(csvCell(cell).replace(/^"/, '').startsWith("'"), cell)
    }
    assert.equal(csvCell('-12.50'), '-12.50')
    assert.equal(csvCell('a,b'), '"a,b"')
    assert.equal(csvCell('linha\nnova'), '"linha\nnova"')
    assert.equal(csvCell(null), '')
    assert.equal(csvCell(42), '42')
    assert.equal(csvLine(['a', '=b', 3]), "a,'=b,3\r\n")
  })

  test('widgets: tipo, relatório, actualização mínima de 30 s e disposição válida', ({
    assert,
  }) => {
    const ok = normalizeWidget({ title: 'Vendas', type: 'KPI', reportId: 'r1' })
    assert.equal(ok.value?.refreshSeconds, 300)
    assert.deepEqual(ok.value?.layout, { x: 0, y: 0, w: 6, h: 4 })
    const bad = (raw: Record<string, unknown>) =>
      normalizeWidget({ title: 'x', type: 'KPI', reportId: 'r1', ...raw }).issues.map((i) => i.path)
    assert.include(bad({ refreshSeconds: 10 }), 'refreshSeconds')
    assert.include(bad({ type: 'RADAR' }), 'type')
    assert.include(bad({ layout: { w: 99 } }), 'layout.w')
    assert.include(bad({ title: '' }), 'title')
    assert.include(bad({ reportId: undefined }), 'reportId')
  })

  test('filtros globais só se aplicam a campos que o dataset tem; os outros ficam registados', ({
    assert,
  }) => {
    const global = [
      { field: 'currency', op: 'eq' as const, value: 'AOA' },
      { field: 'customer_group', op: 'eq' as const, value: 'x' },
    ]
    const result = applyGlobalFilters(DATASET, [{ field: 'kind', op: 'eq', value: 'A' }], global)
    assert.deepEqual(
      result.filters.map((f) => f.field),
      ['kind', 'currency']
    )
    assert.deepEqual(
      result.ignored.map((f) => f.field),
      ['customer_group']
    )
  })

  test('campos visíveis excluem os ocultos', ({ assert }) => {
    assert.notInclude(
      visibleFields(DATASET, HIDDEN).map((f) => f.code),
      'secret'
    )
    assert.lengthOf(visibleFields(DATASET, NONE), DATASET.fields.length)
  })

  test('termos e excertos da pesquisa', ({ assert }) => {
    assert.deepEqual(searchTerms(' a  fatura  2026 '), ['fatura', '2026'])
    const text = `${'x'.repeat(100)} Factura FT 2026/1 da Acme ${'y'.repeat(100)}`
    const snippet = snippetOf(text, ['acme'], 20)
    assert.include(snippet, 'Acme')
    assert.isTrue(snippet.startsWith('…') && snippet.endsWith('…'))
    assert.equal(snippetOf('curto', ['zzz'], 20), 'curto')
  })
})
