import { test } from '@japa/runner'
import {
  available,
  physical,
  postingIssues,
  quantityText,
  reversalLines,
  signedQuantity,
  type PostingLine,
} from '#modules/inventory/domain/stock'

const W = '00000000-0000-4000-8000-000000000001'
const P = '00000000-0000-4000-8000-000000000002'
const L = '00000000-0000-4000-8000-000000000003'
const line = (
  bucket: PostingLine['bucket'],
  q: string,
  locationId: string | null = L
): PostingLine => ({
  warehouseId: W,
  locationId,
  productId: P,
  variantId: null,
  bucket,
  quantity: signedQuantity(q)!,
})
const codes = (i: { code: string }[]) => i.map((x) => x.code)

test.group('Inventário | domínio do stock (8.3)', () => {
  test('quantidades exactas com sinal (6 casas) e derivados', ({ assert }) => {
    assert.equal(signedQuantity('12.5'), 12_500_000n)
    assert.equal(signedQuantity('-0.000001'), -1n)
    assert.isNull(signedQuantity('0'))
    assert.isNull(signedQuantity('1.0000001'))
    assert.isNull(signedQuantity('1e3'))
    assert.isNull(signedQuantity(''))
    assert.equal(quantityText(-1_500_000n), '-1.500000')
    const b = {
      unrestricted: 80n,
      blocked: 5n,
      quarantine: 15n,
      reserved: 30n,
      inTransit: 7n,
      expected: 100n,
    }
    assert.equal(physical(b), 100n)
    assert.equal(available(b), 50n)
    assert.deepEqual(
      reversalLines([line('UNRESTRICTED', '3')]).map((l) => l.quantity),
      [-3_000_000n]
    )
  })

  test('baldes e sinais permitidos por tipo de lançamento', ({ assert }) => {
    assert.deepEqual(
      postingIssues('RECEIPT', [line('UNRESTRICTED', '5'), line('EXPECTED', '-5', null)]),
      []
    )
    assert.include(
      codes(postingIssues('RECEIPT', [line('UNRESTRICTED', '-5')])),
      'BUCKET_NOT_ALLOWED'
    )
    assert.include(
      codes(postingIssues('RECEIPT', [line('RESERVED', '5', null)])),
      'BUCKET_NOT_ALLOWED'
    )
    assert.deepEqual(
      postingIssues('ISSUE', [line('UNRESTRICTED', '-5'), line('RESERVED', '-5', null)]),
      []
    )
    assert.include(codes(postingIssues('ISSUE', [line('UNRESTRICTED', '5')])), 'BUCKET_NOT_ALLOWED')
    assert.include(codes(postingIssues('RESERVATION', [line('RESERVED', '5')])), 'NO_LOCATION')
    assert.include(
      codes(postingIssues('RELEASE', [line('RESERVED', '5', null)])),
      'BUCKET_NOT_ALLOWED'
    )
    assert.deepEqual(
      postingIssues('TRANSFER_OUT', [line('UNRESTRICTED', '-2'), line('IN_TRANSIT', '2', null)]),
      []
    )
    assert.deepEqual(postingIssues('EXPECTED', [line('EXPECTED', '-3', null)]), [])
    assert.include(codes(postingIssues('REVERSAL', [line('UNRESTRICTED', '1')])), 'INVALID')
    assert.include(codes(postingIssues('ADJUSTMENT', [])), 'REQUIRED')
    // Mudança de estado: o físico de cada saldo mantém-se.
    assert.deepEqual(
      postingIssues('STATUS_CHANGE', [line('UNRESTRICTED', '-2'), line('QUARANTINE', '2')]),
      []
    )
    assert.include(
      codes(postingIssues('STATUS_CHANGE', [line('UNRESTRICTED', '-2'), line('BLOCKED', '1')])),
      'NOT_BALANCED'
    )
    assert.include(
      codes(
        postingIssues('STATUS_CHANGE', [line('UNRESTRICTED', '-2'), line('RESERVED', '2', null)])
      ),
      'BUCKET_NOT_ALLOWED'
    )
  })
})
