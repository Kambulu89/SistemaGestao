import { test } from '@japa/runner'
import {
  collectionOf,
  noteLineNet,
  normalizeNoteHeader,
  normalizeNoteLines,
  originalTaxes,
  reasonIssue,
} from '#modules/sales/domain/notes'

const L = '00000000-0000-4000-8000-000000000001'
const room = (creditedQty = 0n, creditedNet = 0n) => ({
  quantity: 3_000000n,
  netUnitPrice: '33.3333',
  netAmount: 10000n, // 100,00 (3 × 33,3333 arredondado)
  creditedQty,
  creditedNet,
})

test.group('Vendas | notas (domínio)', () => {
  test('cabeçalho e linhas: tipo, motivo do tipo, débito só por valor, linhas repetidas', ({
    assert,
  }) => {
    const h = normalizeNoteHeader({ kind: 'X', invoiceId: 'y', reason: 'ab' }, true)
    assert.includeMembers(
      h.issues.map((i) => i.path),
      ['kind', 'invoiceId', 'reasonCode', 'reason', 'noteDate']
    )
    assert.isNull(reasonIssue('CREDIT', 'RETURN'))
    assert.equal(reasonIssue('CREDIT', 'INTEREST')?.path, 'reasonCode')
    assert.equal(
      normalizeNoteLines([{ invoiceLineId: L, mode: 'QUANTITY', quantity: '1' }], 'DEBIT').issues[0]
        .path,
      'lines.0.mode'
    )
    assert.equal(
      normalizeNoteLines(
        [
          { invoiceLineId: L, mode: 'VALUE', amount: '1' },
          { invoiceLineId: L, mode: 'VALUE', amount: '1' },
        ],
        'CREDIT'
      ).issues[0].path,
      'lines.1.invoiceLineId'
    )
  })

  test('elegível exacto: quantidade × preço, o resto todo credita o valor que falta, nunca acima', ({
    assert,
  }) => {
    const q = (x: bigint) => ({
      invoiceLineId: L,
      mode: 'QUANTITY' as const,
      quantity: x,
      amount: null,
    })
    const v = (x: bigint) => ({
      invoiceLineId: L,
      mode: 'VALUE' as const,
      quantity: null,
      amount: x,
    })
    assert.equal(noteLineNet('CREDIT', q(1_000000n), room()).net, 3333n) // 33,33
    // Últimas 2 unidades depois de 1 creditada a 33,33: crédito exacto do que falta (66,67).
    assert.equal(noteLineNet('CREDIT', q(2_000000n), room(1_000000n, 3333n)).net, 6667n)
    assert.equal(
      noteLineNet('CREDIT', q(3_000000n), room(1_000000n, 3333n)).issue?.code,
      'OVER_CREDIT'
    )
    assert.equal(noteLineNet('CREDIT', v(10001n), room()).issue?.code, 'OVER_CREDIT')
    assert.equal(noteLineNet('CREDIT', v(10000n), room()).net, 10000n)
    // Crédito por valor esgota o líquido: a quantidade que resta já não tem valor.
    assert.equal(
      noteLineNet('CREDIT', q(1_000000n), room(0n, 10000n)).issue?.code,
      'NOTHING_TO_CREDIT'
    )
    // Débito: o valor indicado.
    assert.equal(noteLineNet('DEBIT', v(500n), room()).net, 500n)
  })

  test('impostos originais: retenção só se aplicada na factura; estado de cobrança com créditos e débitos', ({
    assert,
  }) => {
    const taxes = [
      { codeId: 'a', code: 'T', kind: 'TAX', rate: '14.0000', exemptionCode: null },
      { codeId: 'b', code: 'R', kind: 'WITHHOLDING', rate: '6.5000', exemptionCode: null },
    ]
    assert.deepEqual(
      originalTaxes(taxes, new Set()).map((t) => t.code),
      ['T']
    )
    assert.deepEqual(
      originalTaxes(taxes, new Set(['b'])).map((t) => [t.code, t.minBase]),
      [
        ['T', null],
        ['R', null],
      ]
    )
    assert.equal(collectionOf(1000n, 0n, 0n, 0n), 'UNPAID')
    assert.equal(collectionOf(1000n, 0n, 400n, 0n), 'PARTIAL')
    assert.equal(collectionOf(1000n, 0n, 400n, 600n), 'PAID')
    assert.equal(collectionOf(1000n, 200n, 0n, 1000n), 'PARTIAL')
  })
})
