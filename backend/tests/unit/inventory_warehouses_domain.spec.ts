import { test } from '@japa/runner'
import {
  childLevel,
  isLocationCode,
  pathCode,
  seriesCodes,
  warehouseAccess,
} from '#modules/inventory/domain/warehouses'

test.group('Inventário | domínio dos armazéns (8.2)', () => {
  test('hierarquia, códigos de caminho e séries', ({ assert }) => {
    assert.equal(childLevel(null), 'ZONE')
    assert.equal(childLevel('ZONE'), 'AISLE')
    assert.equal(childLevel('RACK'), 'BIN')
    assert.isNull(childLevel('BIN'))
    assert.equal(pathCode(null, 'A'), 'A')
    assert.equal(pathCode('A-01', '03'), 'A-01-03')
    assert.isTrue(isLocationCode('P01'))
    assert.isFalse(isLocationCode('p-01'))
    assert.deepEqual(seriesCodes('p', 1, 3, 2), ['P01', 'P02', 'P03'])
    assert.lengthOf(seriesCodes('', 1, 200, 3)!, 200)
    assert.isNull(seriesCodes('P', 1, 201, 3))
    assert.isNull(seriesCodes('P', 5, 1, 2))
    assert.isNull(seriesCodes('P-', 1, 2, 2))
  })

  test('acesso: gestão, âmbito de leitura e lista dos restritos', ({ assert }) => {
    const base = { manage: false, read: true, mode: 'OPEN' as const, entry: null }
    assert.deepEqual(warehouseAccess({ ...base, manage: true, read: false, mode: 'RESTRICTED' }), {
      read: true,
      operate: true,
      manage: true,
    })
    assert.deepEqual(warehouseAccess(base), { read: true, operate: true, manage: false })
    assert.isNull(warehouseAccess({ ...base, read: false }))
    assert.isNull(warehouseAccess({ ...base, mode: 'RESTRICTED' }))
    assert.deepEqual(warehouseAccess({ ...base, mode: 'RESTRICTED', entry: 'VIEW' }), {
      read: true,
      operate: false,
      manage: false,
    })
    // Na lista mas sem inventory.read no âmbito: nada.
    assert.isNull(warehouseAccess({ ...base, read: false, mode: 'RESTRICTED', entry: 'OPERATE' }))
  })
})
