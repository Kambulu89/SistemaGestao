import { test } from '@japa/runner'
import {
  buildLines,
  defaultKey,
  fillTemplate,
  type RuleLine,
} from '#modules/accounting/domain/posting'

const line = (
  lineNo: number,
  side: 'DEBIT' | 'CREDIT',
  amountKey: string,
  extra: Partial<RuleLine> = {}
): RuleLine => ({
  lineNo,
  side,
  accountId: `acc-${lineNo}`,
  amountKey,
  description: null,
  costCenterId: null,
  useEventCostCenter: false,
  useEventThirdParty: false,
  ...extra,
})

test.group('contabilização | regras puras', () => {
  test('linhas a partir dos montantes; zero omite a linha; dimensões do evento quando a regra o pede', ({
    assert,
  }) => {
    const rule = [
      line(1, 'DEBIT', 'total', { useEventThirdParty: true }),
      line(2, 'CREDIT', 'net', { useEventCostCenter: true, description: 'Venda {sourceRef}' }),
      line(3, 'CREDIT', 'tax'),
    ]
    const { lines, issues } = buildLines(
      rule,
      {
        source: 'SALES',
        event: 'ISSUED',
        sourceRef: 'FT 1',
        amounts: { total: '100', net: '100', tax: '0' },
        costCenterId: 'cc',
        thirdPartyRef: 'NIF1',
      },
      2
    )
    assert.deepEqual(issues, [])
    assert.deepEqual(lines, [
      {
        accountId: 'acc-1',
        description: null,
        debit: '100',
        credit: null,
        costCenterId: null,
        thirdPartyRef: 'NIF1',
      },
      {
        accountId: 'acc-2',
        description: 'Venda FT 1',
        debit: null,
        credit: '100',
        costCenterId: 'cc',
        thirdPartyRef: null,
      },
    ])
  })

  test('montante em falta ou inválido é erro, nunca zero implícito', ({ assert }) => {
    const { issues } = buildLines(
      [line(1, 'DEBIT', 'total'), line(2, 'CREDIT', 'net')],
      { source: 'S', event: 'E', sourceRef: 'R', amounts: { total: '1.234' } },
      2
    )
    assert.sameMembers(
      issues.map((i) => i.code),
      ['INVALID_AMOUNT', 'AMOUNT_MISSING']
    )
  })

  test('modelo de descrição e chave por omissão', ({ assert }) => {
    const e = { source: 'SALES', event: 'ISSUED', sourceRef: 'FT 9' }
    assert.equal(fillTemplate('{source}/{event} {sourceRef}', e), 'SALES/ISSUED FT 9')
    assert.equal(defaultKey(e), 'SALES:ISSUED:FT 9')
  })
})
