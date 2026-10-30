import { describe, expect, it } from 'vitest';
import type { PermissionDto } from '../data-access/iam.api';
import { groupPermissions, toggleCode } from './roles-model';

const p = (code: string, moduleCode: string): PermissionDto => ({
  id: code,
  code,
  moduleCode,
  description: code,
});

describe('modelo dos perfis', () => {
  it('agrupa as permissões por módulo, tudo ordenado', () => {
    const groups = groupPermissions([
      p('party.update', 'party'),
      p('catalog.read', 'catalog'),
      p('party.read', 'party'),
    ]);
    expect(groups.map((g) => g.moduleCode)).toEqual(['catalog', 'party']);
    expect(groups[1]?.permissions.map((x) => x.code)).toEqual(['party.read', 'party.update']);
  });

  it('liga e desliga um código sem repetir', () => {
    expect(toggleCode(['b.read'], 'a.read', true)).toEqual(['a.read', 'b.read']);
    expect(toggleCode(['a.read', 'b.read'], 'a.read', true)).toEqual(['a.read', 'b.read']);
    expect(toggleCode(['a.read', 'b.read'], 'a.read', false)).toEqual(['b.read']);
    expect(toggleCode([], 'a.read', false)).toEqual([]);
  });
});
