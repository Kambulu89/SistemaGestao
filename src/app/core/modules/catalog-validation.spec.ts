import { defineModule } from './define-module';
import type { ModuleGroup } from './module.model';
import { validateCatalog } from './catalog-validation';

const groups: ModuleGroup[] = [
  { id: 'crm', name: 'CRM', description: '', icon: 'users', order: 1 },
];
const mod = (code: string, extra: Partial<Parameters<typeof defineModule>[0]> = {}) =>
  defineModule({ code, name: code, description: '', group: 'crm', icon: 'cube', ...extra });

describe('validateCatalog', () => {
  it('accepts a coherent catalog', () => {
    expect(
      validateCatalog(groups, [mod('crm.a'), mod('crm.b', { dependencies: ['crm.a'] })]),
    ).toEqual([]);
  });

  it('reports duplicates, unknown groups and unknown dependencies', () => {
    const issues = validateCatalog(groups, [
      mod('crm.a'),
      mod('crm.a'),
      mod('crm.b', { group: 'nope', dependencies: ['crm.ghost'] }),
    ]);
    expect(issues.join('\n')).toContain('Código duplicado: crm.a');
    expect(issues.join('\n')).toContain('Id duplicado');
    expect(issues.join('\n')).toContain('grupo desconhecido "nope"');
    expect(issues.join('\n')).toContain('dependência desconhecida');
  });

  it('detects circular dependencies', () => {
    const issues = validateCatalog(groups, [
      mod('crm.a', { dependencies: ['crm.b'] }),
      mod('crm.b', { dependencies: ['crm.a'] }),
    ]);
    expect(issues.some((i) => i.startsWith('Dependência circular'))).toBe(true);
  });

  it('rejects an access permission that the module does not declare', () => {
    const issues = validateCatalog(groups, [mod('crm.a', { accessPermission: 'crm.other.read' })]);
    expect(issues.join('\n')).toContain('accessPermission');
  });

  it('forbids foundation capabilities from depending on anything', () => {
    const issues = validateCatalog(groups, [
      mod('crm.a'),
      mod('crm.f', { kind: 'foundation', dependencies: ['crm.a'] }),
    ]);
    expect(issues.join('\n')).toContain('fundação');
  });
});
