import { NAVIGATION, flatNavigation, sectionsOf, visibleNavigation } from './navigation';

const labels = (groups: ReturnType<typeof visibleNavigation>) =>
  groups.flatMap((g) => g.items.map((i) => i.label));

describe('visibleNavigation', () => {
  it('sem permissões nem funcionalidades só mostra o essencial', () => {
    const items = labels(
      visibleNavigation(
        () => false,
        () => false,
        true,
        false,
      ),
    );
    expect(items).toEqual(['Painel', 'Notificações']);
  });

  it('exige a permissão e a funcionalidade contratada', () => {
    const perms = new Set(['organization.read', 'members.read']);
    const withoutFeature = labels(
      visibleNavigation(
        (p) => perms.has(p),
        () => false,
        true,
        false,
      ),
    );
    expect(withoutFeature).toContain('Membros');
    expect(withoutFeature).not.toContain('Entidades legais');
    const withFeature = labels(
      visibleNavigation(
        (p) => perms.has(p),
        (f) => f === 'organization',
        true,
        false,
      ),
    );
    expect(withFeature).toContain('Entidades legais');
    expect(withFeature).not.toContain('Perfis');
  });

  it('sem empresa só mostra a plataforma ao administrador', () => {
    expect(
      visibleNavigation(
        () => true,
        () => true,
        false,
        false,
      ),
    ).toEqual([]);
    const platform = visibleNavigation(
      () => true,
      () => true,
      false,
      true,
    );
    expect(platform.map((g) => g.label)).toEqual(['Plataforma']);
  });
});

describe('navegação por domínios', () => {
  it('agrupa por domínio do ERP e só com ecrãs reais', () => {
    expect(NAVIGATION.map((g) => g.label)).toEqual([
      'Início',
      'Gestão Financeira',
      'Administração e Plataforma',
      'Integrações e Compliance',
    ]);
    const paths = flatNavigation(NAVIGATION).map((i) => i.path);
    expect(new Set(paths).size).toBe(paths.length);
  });

  it('secções pela ordem de aparição e filtradas com o resto', () => {
    const finance = NAVIGATION.find((g) => g.label === 'Gestão Financeira')!;
    expect(sectionsOf(finance).map((s) => s.title)).toEqual([
      'Contabilidade',
      'Relatórios financeiros',
      'Activos e regularizações',
      'Configuração financeira',
    ]);
    const reportsOnly = visibleNavigation(
      (p) => p === 'accounting.reports',
      (f) => f === 'accounting',
      true,
      false,
    ).find((g) => g.label === 'Gestão Financeira')!;
    expect(sectionsOf(reportsOnly).map((s) => s.title)).toEqual(['Relatórios financeiros']);
  });
});
