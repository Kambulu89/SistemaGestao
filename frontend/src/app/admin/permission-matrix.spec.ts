import { groupPermissions, permissionDiff } from './permission-matrix';

describe('matriz de permissões', () => {
  it('agrupa por módulo mantendo a ordem do catálogo', () => {
    const groups = groupPermissions([
      { code: 'a.read', module: 'a', description: '' },
      { code: 'b.read', module: 'b', description: '' },
      { code: 'a.manage', module: 'a', description: '' },
    ]);
    expect(groups.map((g) => [g.module, g.items.map((i) => i.code)])).toEqual([
      ['a', ['a.read', 'a.manage']],
      ['b', ['b.read']],
    ]);
  });

  it('diferença entre o guardado e o editado', () => {
    expect(permissionDiff(['x', 'y'], new Set(['y', 'z']))).toEqual({
      added: ['z'],
      removed: ['x'],
    });
  });
});
