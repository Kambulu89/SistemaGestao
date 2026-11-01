import { test } from '@japa/runner'
import {
  normalizeStatement,
  planMatch,
  remainingOf,
  stateOf,
  suggest,
  type SuggestionEntry,
} from '#modules/finance/domain/reconciliation'

test.group('conciliação | extracto', () => {
  test('normaliza o valor com sinal e dá a mesma identidade ao mesmo ficheiro', ({ assert }) => {
    const lines = [
      { occurredOn: '2026-10-10', amount: '10', description: ' Comissão ' },
      { occurredOn: '2026-10-10', amount: '10.0000', description: 'Comissão' },
      { occurredOn: '2026-10-10', amount: '-3.5' },
    ]
    const first = normalizeStatement(lines)
    const second = normalizeStatement(lines)
    assert.deepEqual(first.issues, [])
    assert.deepEqual(
      first.values.map((v) => v.amountSigned),
      ['10.0000', '10.0000', '-3.5000']
    )
    // Duas linhas iguais no mesmo ficheiro não se fundem; importar de novo dá as mesmas identidades.
    assert.notEqual(first.values[0].fingerprint, first.values[1].fingerprint)
    assert.deepEqual(
      first.values.map((v) => v.fingerprint),
      second.values.map((v) => v.fingerprint)
    )
  })

  test('o identificador do banco prevalece e não se repete no ficheiro', ({ assert }) => {
    const ok = normalizeStatement([{ externalId: 'X1', occurredOn: '2026-10-10', amount: '1' }])
    assert.equal(ok.values[0].fingerprint, 'ext:X1')
    const dup = normalizeStatement([
      { externalId: 'X1', occurredOn: '2026-10-10', amount: '1' },
      { externalId: 'X1', occurredOn: '2026-10-11', amount: '2' },
    ])
    assert.deepEqual(
      dup.issues.map((i) => i.code),
      ['DUPLICATE_EXTERNAL_ID']
    )
  })

  test('recusa datas, valores e textos inválidos e ficheiros vazios ou grandes', ({ assert }) => {
    const codes = (lines: unknown) => normalizeStatement(lines).issues.map((i) => i.code)
    assert.deepEqual(codes([]), ['REQUIRED'])
    assert.deepEqual(codes('x'), ['REQUIRED'])
    assert.deepEqual(codes([{ occurredOn: '2026-13-01', amount: '1' }]), ['INVALID_DATE'])
    assert.deepEqual(codes([{ occurredOn: '2026-02-30', amount: '1' }]), ['INVALID_DATE'])
    assert.deepEqual(codes([{ occurredOn: '2026-10-01', amount: '0.0000' }]), ['ZERO_AMOUNT'])
    assert.deepEqual(codes([{ occurredOn: '2026-10-01', amount: '1.23456' }]), ['INVALID_AMOUNT'])
    assert.deepEqual(codes([{ occurredOn: '2026-10-01', amount: 5 }]), ['INVALID_AMOUNT'])
    assert.deepEqual(
      codes([{ occurredOn: '2026-10-01', amount: '1', reference: 'x'.repeat(121) }]),
      ['TOO_LONG']
    )
    const many = Array.from({ length: 1001 }, () => ({ occurredOn: '2026-10-01', amount: '1' }))
    assert.deepEqual(codes(many), ['TOO_MANY'])
  })
})

test.group('conciliação | estado derivado', () => {
  test('o estado vem do conciliado contra o total, em valor absoluto', ({ assert }) => {
    assert.equal(stateOf('-100.0000', '0.0000'), 'UNMATCHED')
    assert.equal(stateOf('-100.0000', '99.9999'), 'PARTIAL')
    assert.equal(stateOf('100.0000', '100.0000'), 'MATCHED')
    assert.equal(remainingOf('-100.0000', '30.5000'), '69.5000')
    assert.equal(remainingOf('100.0000', '100.0000'), '0.0000')
  })
})

test.group('conciliação | planear uma correspondência', () => {
  const side = (amountSigned: string, remaining: string, accountId = 'a') => ({
    accountId,
    amountSigned,
    remaining,
  })

  test('sem valor pedido concilia o máximo possível', ({ assert }) => {
    assert.deepEqual(
      planMatch(side('100.0000', '100.0000'), side('60.0000', '60.0000'), undefined),
      {
        amount: '60.0000',
      }
    )
    assert.deepEqual(
      planMatch(side('100.0000', '30.0000'), side('60.0000', '60.0000'), undefined),
      {
        amount: '30.0000',
      }
    )
  })

  test('recusa conta ou sentido diferentes, lados já conciliados e valores a mais', ({
    assert,
  }) => {
    const codes = (r: ReturnType<typeof planMatch>) =>
      'issues' in r ? r.issues.map((i) => i.code) : ['OK']
    assert.deepEqual(codes(planMatch(side('1', '1', 'a'), side('1', '1', 'b'), undefined)), [
      'ACCOUNT_MISMATCH',
    ])
    assert.deepEqual(codes(planMatch(side('-1', '1'), side('1', '1'), undefined)), [
      'DIRECTION_MISMATCH',
    ])
    assert.deepEqual(codes(planMatch(side('1', '0.0000'), side('1', '0.0000'), undefined)), [
      'LINE_FULLY_MATCHED',
      'ENTRY_FULLY_MATCHED',
    ])
    assert.deepEqual(codes(planMatch(side('10', '10'), side('10', '10'), '10.0001')), [
      'EXCEEDS_REMAINING',
    ])
    assert.deepEqual(codes(planMatch(side('10', '10'), side('10', '10'), '0')), ['INVALID_AMOUNT'])
    assert.deepEqual(codes(planMatch(side('10', '10'), side('10', '10'), '-1')), ['INVALID_AMOUNT'])
    assert.deepEqual(planMatch(side('10', '10'), side('10', '10'), '4.5'), { amount: '4.5000' })
  })
})

test.group('conciliação | sugestões', () => {
  const line = {
    amountSigned: '100.0000',
    remaining: '100.0000',
    occurredOn: '2026-10-10',
    description: 'Transferência recebida REC-9',
    reference: null,
  }
  const entry = (patch: Partial<SuggestionEntry>): SuggestionEntry => ({
    id: 'e',
    amountSigned: '100.0000',
    remaining: '100.0000',
    occurredOn: '2026-10-10',
    reference: null,
    description: null,
    ...patch,
  })

  test('ordena por valor igual, data e referência e ignora sentido contrário e datas longínquas', ({
    assert,
  }) => {
    const result = suggest(line, [
      entry({ id: 'far', occurredOn: '2026-08-01' }),
      entry({ id: 'opposite', amountSigned: '-100.0000' }),
      entry({ id: 'partial', remaining: '40.0000', amountSigned: '40.0000' }),
      entry({ id: 'later', occurredOn: '2026-10-13' }),
      entry({ id: 'exact', reference: 'rec-9' }),
      entry({ id: 'done', remaining: '0.0000' }),
    ])
    assert.deepEqual(
      result.map((s) => s.entryId),
      ['exact', 'later', 'partial']
    )
    assert.equal(result[0].score, 100)
    assert.equal(result[1].score, 75)
    assert.equal(result[2].matchableAmount, '40.0000')
    assert.include(result[0].reasons, 'Referência no extracto')
  })

  test('uma linha já conciliada não tem sugestões', ({ assert }) => {
    assert.deepEqual(suggest({ ...line, remaining: '0.0000' }, [entry({})]), [])
  })
})
