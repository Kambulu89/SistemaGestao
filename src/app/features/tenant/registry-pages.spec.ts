import { signal, type Type } from '@angular/core';
import { type ComponentFixture, TestBed } from '@angular/core/testing';
import { of, throwError } from 'rxjs';
import type { ApiError } from '../../core/api/api-error.model';
import { PermissionService } from '../../core/permissions/permission.service';
import type { TenantSubscriptionDto } from '../../core/subscription/subscription-dto';
import { TenantContextService } from '../../core/tenant-context/tenant-context.service';
import { ModulesApi, type FeatureDto, type ModuleDto } from './data-access/modules.api';
import { OrganizationApi } from './data-access/organization.api';
import {
  SettingsApi,
  type EffectiveSettingDto,
  type SequenceDto,
  type TaxRateDto,
  type UnitDto,
} from './data-access/settings.api';
import { SubscriptionApi } from './data-access/subscription.api';
import { TenantModulesPage } from './modules/tenant-modules-page';
import { TenantPlanPage } from './plan/tenant-plan-page';
import { TenantSettings } from './settings/settings';

const apiError = (status: number, code: string, message: string, fieldErrors = []): ApiError => ({
  status,
  code,
  message,
  fieldErrors,
});

let granted: Set<string>;
const tenant = signal<{ id: string; slug: string } | null>({ id: 't1', slug: 'demo_a' });

function configure(providers: unknown[]): void {
  granted = new Set();
  tenant.set({ id: 't1', slug: 'demo_a' });
  TestBed.configureTestingModule({
    providers: [
      { provide: TenantContextService, useValue: { tenant } },
      { provide: PermissionService, useValue: { can: (p: string) => granted.has(p) } },
      ...(providers as never[]),
    ],
  });
}

async function render<T>(component: Type<T>): Promise<ComponentFixture<T>> {
  const fixture = TestBed.createComponent(component);
  await fixture.whenStable();
  fixture.detectChanges();
  return fixture;
}
const text = (f: ComponentFixture<unknown>) => (f.nativeElement as HTMLElement).textContent ?? '';
const button = (f: ComponentFixture<unknown>, label: string) =>
  [...(f.nativeElement as HTMLElement).querySelectorAll('button')].find((b) =>
    b.textContent?.trim().includes(label),
  ) as HTMLButtonElement | undefined;
/** Clica no último botão com este texto (o de um diálogo aberto vem depois do da página). */
async function click(f: ComponentFixture<unknown>, label: string): Promise<void> {
  const target = [...(f.nativeElement as HTMLElement).querySelectorAll('button')]
    .filter((b) => b.textContent?.trim().includes(label))
    .at(-1);
  expect(target, `botão "${label}"`).toBeDefined();
  target!.click();
  await f.whenStable();
  f.detectChanges();
}
async function type(f: ComponentFixture<unknown>, label: string, value: string): Promise<void> {
  const field = [...(f.nativeElement as HTMLElement).querySelectorAll('label')].find((l) =>
    l.textContent?.includes(label),
  );
  const input = document.getElementById(
    field?.getAttribute('for') ?? '',
  ) as HTMLInputElement | null;
  expect(input, `campo "${label}"`).not.toBeNull();
  input!.value = value;
  input!.dispatchEvent(new Event(input!.tagName === 'SELECT' ? 'change' : 'input'));
  f.detectChanges();
}

// --- plano ---------------------------------------------------------------------------------------

const subscription = (
  over: Partial<TenantSubscriptionDto['subscription']> = {},
): TenantSubscriptionDto => ({
  plan: {
    code: 'demo_basic',
    revision: 2,
    name: 'Demo Básico',
    price: '49.9000',
    currency: 'AOA',
    billingInterval: 'MONTH',
    limits: { members: 10 },
    entitlements: { modules: ['crm'], features: ['crm.scoring'] },
  },
  subscription: {
    status: 'ACTIVE',
    entitled: true,
    startsAt: '2026-01-01T00:00:00.000Z',
    periodEnd: '2026-02-01T00:00:00.000Z',
    trialEnd: null,
    graceEnd: null,
    adequacyUntil: null,
    cancelAtPeriodEnd: false,
    ...over,
  },
  usage: [{ metric: 'members', used: 3, limit: 10, blocked: false }],
  history: [
    {
      kind: 'ASSIGNED',
      fromStatus: null,
      toStatus: 'ACTIVE',
      adequacyUntil: null,
      occurredAt: '2026-01-01T10:00:00.000Z',
    },
  ],
});

describe('TenantPlanPage', () => {
  let api: { current: ReturnType<typeof vi.fn> };

  beforeEach(() => {
    api = { current: vi.fn(() => of(subscription())) };
    configure([{ provide: SubscriptionApi, useValue: api }]);
  });

  it('shows the contracted version: price as a string, usage, limits, entitlements and history', async () => {
    const t = text(await render(TenantPlanPage));
    expect(t).toContain('Demo Básico');
    expect(t).toContain('revisão 2');
    expect(t).toContain('49.9000 AOA / mês');
    expect(t).toContain('3 / 10');
    expect(t).toContain('crm');
    expect(t).toContain('crm.scoring');
    expect(t).toContain('Plano atribuído');
    expect(t).not.toContain('Bloqueado');
  });

  it('flags a blocked metric and the adequacy period (nothing is deleted)', async () => {
    api.current.mockReturnValue(
      of({
        ...subscription({ adequacyUntil: '2026-03-01T00:00:00.000Z' }),
        usage: [{ metric: 'members', used: 3, limit: 1, blocked: true }],
      }),
    );
    const t = text(await render(TenantPlanPage));
    expect(t).toContain('Bloqueado');
    expect(t).toContain('Período de adequação');
    expect(t).toContain('nada é eliminado');
  });

  it('warns when the subscription grants no entitlements', async () => {
    api.current.mockReturnValue(of(subscription({ status: 'SUSPENDED', entitled: false })));
    const t = text(await render(TenantPlanPage));
    expect(t).toContain('Sem direitos activos');
    expect(t).toContain('Suspensa');
  });

  it('explains a tenant without a plan (404) and other failures differently', async () => {
    api.current.mockReturnValue(
      throwError(() => apiError(404, 'NOT_FOUND', 'O tenant não tem assinatura.')),
    );
    expect(text(await render(TenantPlanPage))).toContain('Este tenant não tem plano');

    TestBed.resetTestingModule();
    api = { current: vi.fn(() => throwError(() => apiError(500, 'INTERNAL', 'Falha interna'))) };
    configure([{ provide: SubscriptionApi, useValue: api }]);
    expect(text(await render(TenantPlanPage))).toContain('Não foi possível carregar o plano');
  });

  it('asks again when the active tenant changes', async () => {
    const f = await render(TenantPlanPage);
    expect(api.current).toHaveBeenCalledTimes(1);
    tenant.set({ id: 't2', slug: 'demo_b' });
    await f.whenStable();
    f.detectChanges();
    expect(api.current).toHaveBeenCalledTimes(2);
  });
});

// --- módulos -------------------------------------------------------------------------------------

const feature = (over: Partial<FeatureDto> = {}): FeatureDto => ({
  code: 'sales.quotes',
  name: 'Orçamentos',
  moduleCode: 'sales',
  enabled: false,
  reason: 'MODULE_DISABLED',
  override: null,
  overrideReason: null,
  overrideExpiresAt: null,
  ...over,
});

const moduleDto = (over: Partial<ModuleDto> = {}): ModuleDto => ({
  code: 'sales',
  name: 'Vendas',
  kind: 'MODULE',
  releaseVersion: '1.2.0',
  registryStatus: 'AVAILABLE',
  requires: [
    { code: 'core', constraint: '*', optional: false },
    { code: 'crm', constraint: '^1', optional: false },
    { code: 'finance', constraint: '*', optional: true },
  ],
  licensed: true,
  status: 'DISABLED',
  enabledAt: null,
  lastError: null,
  missingDependencies: ['crm'],
  activeDependents: [],
  features: [feature()],
  ...over,
});

describe('TenantModulesPage', () => {
  let api: Record<'list' | 'enable' | 'disable' | 'setFeatureOverride', ReturnType<typeof vi.fn>>;

  beforeEach(() => {
    api = {
      list: vi.fn(() =>
        of([
          moduleDto({
            code: 'core',
            name: 'Núcleo',
            kind: 'FOUNDATION',
            status: 'ENABLED',
            requires: [],
            missingDependencies: [],
            features: [],
          }),
          moduleDto(),
          moduleDto({
            code: 'inventory',
            name: 'Stock',
            licensed: false,
            requires: [],
            missingDependencies: [],
            features: [],
          }),
        ]),
      ),
      enable: vi.fn(() => of(moduleDto({ status: 'ENABLED' }))),
      disable: vi.fn(() => of({ module: moduleDto(), affectedFeatures: ['sales.quotes'] })),
      setFeatureOverride: vi.fn(() => of(feature())),
    };
    configure([{ provide: ModulesApi, useValue: api }]);
    granted.add('tenant.modules.read').add('tenant.modules.manage');
  });

  it('lists the registry with licence, state, requirements and the reason a feature is unavailable', async () => {
    const t = text(await render(TenantModulesPage));
    expect(t).toContain('Núcleo (sempre activo)');
    expect(t).toContain('Vendas');
    expect(t).toContain('Requer: crm, finance (opcional)');
    expect(t).toContain('Licenciado');
    expect(t).toContain('Não licenciado');
    expect(t).toContain('O módulo está desactivado');
  });

  it('lists but offers no actions without module.manage', async () => {
    granted.delete('tenant.modules.manage');
    const f = await render(TenantModulesPage);
    expect(text(f)).toContain('Vendas');
    expect(button(f, 'Activar')).toBeUndefined();
    expect(button(f, 'Alterar')).toBeUndefined();
  });

  it('disables the action for an unlicensed module', async () => {
    const f = await render(TenantModulesPage);
    const stock = [...(f.nativeElement as HTMLElement).querySelectorAll('app-card')].find((c) =>
      c.textContent?.includes('Stock'),
    )!;
    expect((stock.querySelector('button') as HTMLButtonElement).disabled).toBe(true);
    expect(stock.textContent).toContain('O plano contratado não inclui este módulo');
  });

  it('tells which extra modules are needed before enabling and enables them together', async () => {
    const f = await render(TenantModulesPage);
    const sales = [...(f.nativeElement as HTMLElement).querySelectorAll('app-card')].find((c) =>
      c.textContent?.includes('Vendas'),
    )!;
    (sales.querySelector('button') as HTMLButtonElement).click();
    await f.whenStable();
    f.detectChanges();
    expect(text(f)).toContain('é preciso activar também');
    expect(text(f)).toContain('crm');
    await click(f, 'Activar');
    expect(api.enable).toHaveBeenCalledWith('sales', true);
    expect(text(f)).toContain('Vendas activado.');
    expect(api.list).toHaveBeenCalledTimes(2);
  });

  it('shows the server explanation and refreshes when enabling is refused', async () => {
    api.enable.mockReturnValue(
      throwError(() =>
        apiError(409, 'MODULE_NOT_LICENSED', 'x', [
          { path: 'licence', code: 'MODULE_NOT_LICENSED', message: 'crm' } as never,
        ]),
      ),
    );
    const f = await render(TenantModulesPage);
    const sales = [...(f.nativeElement as HTMLElement).querySelectorAll('app-card')].find((c) =>
      c.textContent?.includes('Vendas'),
    )!;
    (sales.querySelector('button') as HTMLButtonElement).click();
    await f.whenStable();
    f.detectChanges();
    await click(f, 'Activar');
    expect(text(f)).toContain('O plano contratado não inclui todos os módulos necessários.');
    expect(text(f)).toContain('crm');
    expect(api.list).toHaveBeenCalledTimes(2);
  });

  it('retries a module left in ERROR, with the generic message only', async () => {
    api.list.mockReturnValue(
      of([
        moduleDto({
          status: 'ERROR',
          lastError: 'A activação falhou; pode tentar novamente.',
          missingDependencies: [],
        }),
      ]),
    );
    const f = await render(TenantModulesPage);
    expect(text(f)).toContain('A activação falhou');
    expect(button(f, 'Tentar de novo')).toBeDefined();
  });

  it('blocks disabling while active modules depend on it, and otherwise keeps data', async () => {
    api.list.mockReturnValue(
      of([
        moduleDto({
          code: 'crm',
          name: 'CRM',
          status: 'ENABLED',
          requires: [],
          missingDependencies: [],
          activeDependents: ['sales'],
          features: [],
        }),
      ]),
    );
    let f = await render(TenantModulesPage);
    await click(f, 'Desactivar');
    expect(text(f)).toContain('Desactive primeiro: sales');
    const confirm = [...(f.nativeElement as HTMLElement).querySelectorAll('button')]
      .filter((b) => b.textContent?.includes('Desactivar'))
      .at(-1) as HTMLButtonElement;
    expect(confirm.disabled).toBe(true);

    TestBed.resetTestingModule();
    api.list.mockReturnValue(
      of([
        moduleDto({
          status: 'ENABLED',
          missingDependencies: [],
          features: [feature({ enabled: true, reason: null })],
        }),
      ]),
    );
    configure([{ provide: ModulesApi, useValue: api }]);
    granted.add('tenant.modules.read').add('tenant.modules.manage');
    f = await render(TenantModulesPage);
    await click(f, 'Desactivar');
    expect(text(f)).toContain('os dados e o histórico não são apagados');
    expect(text(f)).toContain('Funcionalidades afectadas: sales.quotes');
    const go = [...(f.nativeElement as HTMLElement).querySelectorAll('button')]
      .filter((b) => b.textContent?.includes('Desactivar'))
      .at(-1) as HTMLButtonElement;
    go.click();
    await f.whenStable();
    f.detectChanges();
    expect(api.disable).toHaveBeenCalledWith('sales');
    expect(text(f)).toContain('desactivado; os dados foram mantidos');
  });

  it('applies a feature override with a reason and resets it', async () => {
    const f = await render(TenantModulesPage);
    await click(f, 'Alterar');
    await click(f, 'Aplicar');
    expect(api.setFeatureOverride).not.toHaveBeenCalled(); // o motivo é obrigatório
    await type(f, 'Motivo', 'Piloto com a equipa');
    await click(f, 'Aplicar');
    expect(api.setFeatureOverride).toHaveBeenCalledWith('sales.quotes', {
      override: true,
      reason: 'Piloto com a equipa',
      expiresAt: null,
    });
    await click(f, 'Alterar');
    await type(f, 'Acção', 'reset');
    await click(f, 'Aplicar');
    expect(api.setFeatureOverride).toHaveBeenLastCalledWith('sales.quotes', {
      override: null,
      reason: null,
      expiresAt: null,
    });
  });

  it('explains that an override never exceeds the licence', async () => {
    api.setFeatureOverride.mockReturnValue(
      throwError(() => apiError(409, 'FEATURE_NOT_LICENSED', 'x')),
    );
    const f = await render(TenantModulesPage);
    await click(f, 'Alterar');
    await type(f, 'Motivo', 'Quero testar');
    await click(f, 'Aplicar');
    expect(text(f)).toContain('um override não ultrapassa a licença');
  });
});

// --- configurações -------------------------------------------------------------------------------

const setting = (over: Partial<EffectiveSettingDto> = {}): EffectiveSettingDto => ({
  key: 'ui.dateFormat',
  category: 'PRESENTATION',
  description: 'Formato de datas apresentado.',
  spec: { type: 'enum', options: ['dd/MM/yyyy', 'yyyy-MM-dd'] },
  value: 'dd/MM/yyyy',
  source: { level: 'DEFAULT' },
  allowedScopes: ['TENANT', 'ORGANIZATION', 'BRANCH', 'MODULE', 'MEMBERSHIP'],
  ...over,
});

const fiscal = setting({
  key: 'tax.roundingMode',
  category: 'FISCAL',
  description: 'Arredondamento dos impostos.',
  spec: { type: 'enum', options: ['HALF_UP', 'HALF_EVEN'] },
  value: 'HALF_UP',
  allowedScopes: ['TENANT', 'ORGANIZATION'],
});

const org = {
  id: 'o1',
  code: 'MAIN',
  legalName: 'Empresa, Lda.',
  tradeName: null,
  countryCode: 'AO',
  baseCurrency: 'AOA',
  active: true,
  version: 1,
};

describe('TenantSettings', () => {
  let settings: Record<string, ReturnType<typeof vi.fn>>;

  beforeEach(() => {
    settings = {
      effective: vi.fn(() => of([setting(), fiscal])),
      listValues: vi.fn(() => of([])),
      setValue: vi.fn(() => of({})),
      resetValue: vi.fn(() => of(undefined)),
      setPersonal: vi.fn(() => of({})),
      resetPersonal: vi.fn(() => of(undefined)),
      listTaxRates: vi.fn(() => of([])),
      createTaxRate: vi.fn(() => of({})),
      updateTaxRate: vi.fn(() => of({})),
      listUnits: vi.fn(() => of([])),
      createUnit: vi.fn(() => of({})),
      updateUnit: vi.fn(() => of({})),
      convert: vi.fn(() => of({ from: 'KG', to: 'G', quantity: '1.5', result: '1500' })),
      listSequences: vi.fn(() => of([])),
      createSequence: vi.fn(() => of({})),
      updateSequence: vi.fn(() => of({})),
      previewSequence: vi.fn(() => of({ example: 'FT A/2026/000001' })),
    };
    configure([
      { provide: SettingsApi, useValue: settings },
      {
        provide: OrganizationApi,
        useValue: {
          listOrganizations: vi.fn(() => of([org])),
          listUnits: vi.fn(() => of([])),
        },
      },
    ]);
    [
      'tenant.settings.read',
      'tenant.settings.manage',
      'tenant.sequences.manage',
      'organization.units.read',
    ].forEach((p) => granted.add(p));
  });

  async function openTab(f: ComponentFixture<unknown>, label: string): Promise<void> {
    await click(f, label);
  }

  it('shows the effective value and where it comes from', async () => {
    settings['effective']!.mockReturnValue(
      of([
        setting({
          value: 'yyyy-MM-dd',
          source: { level: 'ORGANIZATION', scopeId: 'o1', version: 2 },
        }),
        fiscal,
      ]),
    );
    const t = text(await render(TenantSettings));
    expect(t).toContain('Formato de datas apresentado.');
    expect(t).toContain('yyyy-MM-dd');
    expect(t).toContain('Organização');
    expect(t).toContain('Predefinido');
    expect(t).toContain('Fiscal');
  });

  it('a personal preference is stored in the member scope; fiscal rules offer no personal scope', async () => {
    granted.delete('tenant.settings.manage');
    const f = await render(TenantSettings);
    const rows = [...(f.nativeElement as HTMLElement).querySelectorAll('tbody tr')];
    expect(rows[0]?.textContent).toContain('Alterar');
    expect(rows[1]?.textContent).not.toContain('Alterar'); // fiscal + sem permissão de gerir: nada a oferecer
    (rows[0]!.querySelector('button') as HTMLButtonElement).click();
    await f.whenStable();
    f.detectChanges();
    await type(f, 'Valor', 'yyyy-MM-dd');
    await click(f, 'Guardar');
    expect(settings['setPersonal']).toHaveBeenCalledWith('ui.dateFormat', 'yyyy-MM-dd', undefined);
    expect(text(f)).toContain('Configuração guardada.');
  });

  it('sets a tenant value with the stored version and resets the inheritance', async () => {
    settings['listValues']!.mockReturnValue(
      of([
        {
          key: 'tax.roundingMode',
          scopeType: 'TENANT',
          scopeId: null,
          moduleCode: null,
          value: 'HALF_UP',
          version: 4,
        },
      ]),
    );
    const f = await render(TenantSettings);
    const rows = [...(f.nativeElement as HTMLElement).querySelectorAll('tbody tr')];
    (rows[1]!.querySelector('button') as HTMLButtonElement).click();
    await f.whenStable();
    f.detectChanges();
    expect(text(f)).toContain('Regra fiscal');
    await type(f, 'Valor', 'HALF_EVEN');
    await click(f, 'Guardar');
    expect(settings['setValue']).toHaveBeenCalledWith(
      'tax.roundingMode',
      { scopeType: 'TENANT' },
      'HALF_EVEN',
      4,
    );

    (rows[1]!.querySelector('button') as HTMLButtonElement).click();
    await f.whenStable();
    f.detectChanges();
    await click(f, 'Repor herança');
    expect(settings['resetValue']).toHaveBeenCalledWith('tax.roundingMode', {
      scopeType: 'TENANT',
    });
  });

  it('refreshes and explains when the value changed meanwhile', async () => {
    settings['setValue']!.mockReturnValue(throwError(() => apiError(409, 'VERSION_CONFLICT', 'x')));
    const f = await render(TenantSettings);
    const rows = [...(f.nativeElement as HTMLElement).querySelectorAll('tbody tr')];
    (rows[1]!.querySelector('button') as HTMLButtonElement).click();
    await f.whenStable();
    f.detectChanges();
    await type(f, 'Valor', 'HALF_EVEN');
    await click(f, 'Guardar');
    expect(text(f)).toContain('foi alterado entretanto');
    expect(settings['effective']!.mock.calls.length).toBeGreaterThan(1);
  });

  it('tax rates: lists with the validity period and shows the overlap conflict', async () => {
    const rate: TaxRateDto = {
      id: 'r1',
      organizationId: 'o1',
      code: 'IVA',
      name: 'IVA normal',
      rate: '14.0000',
      validFrom: '2026-01-01',
      validTo: null,
      category: 'VAT',
      exemptionReason: null,
      version: 1,
    };
    settings['listTaxRates']!.mockReturnValue(of([rate]));
    settings['createTaxRate']!.mockReturnValue(
      throwError(() => apiError(409, 'TAX_RATE_OVERLAP', 'x')),
    );
    const f = await render(TenantSettings);
    await openTab(f, 'Impostos');
    expect(settings['listTaxRates']).toHaveBeenCalledWith({ organizationId: 'o1' });
    expect(text(f)).toContain('14.0000 %');
    expect(text(f)).toContain('2026-01-01 → sem fim');

    await click(f, 'Nova taxa');
    await type(f, 'Código', 'iva');
    await type(f, 'Taxa (%)', '15');
    await type(f, 'Nome', 'IVA novo');
    await type(f, 'Categoria', 'VAT');
    await type(f, 'Válida desde', '2026-06-01');
    await click(f, 'Criar');
    expect(settings['createTaxRate']).toHaveBeenCalledWith({
      organizationId: 'o1',
      code: 'IVA',
      name: 'IVA novo',
      rate: '15',
      validFrom: '2026-06-01',
      validTo: null,
      category: 'VAT',
      exemptionReason: null,
    });
    expect(text(f)).toContain('O período sobrepõe-se a outra taxa');
  });

  it('units: lists base and derived units and converts exactly', async () => {
    const kg: UnitDto = {
      id: 'u1',
      code: 'KG',
      name: 'Quilograma',
      dimension: 'MASS',
      precision: 3,
      baseUnitId: null,
      factor: null,
      version: 1,
    };
    const g: UnitDto = {
      id: 'u2',
      code: 'G',
      name: 'Grama',
      dimension: 'MASS',
      precision: 0,
      baseUnitId: 'u1',
      factor: '0.001000',
      version: 1,
    };
    settings['listUnits']!.mockReturnValue(of([kg, g]));
    const f = await render(TenantSettings);
    await openTab(f, 'Unidades');
    expect(text(f)).toContain('Unidade base');
    expect(text(f)).toContain('0.001000 × KG');
    await type(f, 'Quantidade', '1.5');
    await type(f, 'De', 'KG');
    await type(f, 'Para', 'G');
    await click(f, 'Converter');
    expect(settings['convert']).toHaveBeenCalledWith('KG', 'G', '1.5');
    expect(text(f)).toContain('1.5 KG = 1500 G');
  });

  it('units: creating a base unit after a derived one does not inherit the factor requirement', async () => {
    const kg: UnitDto = {
      id: 'u1',
      code: 'KG',
      name: 'Quilograma',
      dimension: 'MASS',
      precision: 3,
      baseUnitId: null,
      factor: null,
      version: 1,
    };
    settings['listUnits']!.mockReturnValue(of([kg]));
    const f = await render(TenantSettings);
    await openTab(f, 'Unidades');
    const fill = async (code: string, base: string, factor: string) => {
      await click(f, 'Nova unidade');
      await type(f, 'Código', code);
      await type(f, 'Nome', code);
      await type(f, 'Dimensão', 'MASS');
      await type(f, 'Unidade base (opcional)', base);
      if (factor) await type(f, 'Factor', factor);
      await click(f, 'Criar');
    };
    await fill('TON', 'u1', ''); // derivada sem factor: recusada no cliente
    expect(settings['createUnit']).not.toHaveBeenCalled();
    await fill('TON', 'u1', '1000');
    expect(settings['createUnit']).toHaveBeenLastCalledWith(
      expect.objectContaining({ code: 'TON', baseUnitId: 'u1', conversionFactor: '1000' }),
    );
    await fill('L', '', ''); // base: o factor deixou de ser exigido
    expect(settings['createUnit']).toHaveBeenCalledTimes(2);
    expect(settings['createUnit']).toHaveBeenLastCalledWith(
      expect.objectContaining({ code: 'L', baseUnitId: null, conversionFactor: null }),
    );
  });

  it('units: shows why a conversion across dimensions is refused', async () => {
    settings['listUnits']!.mockReturnValue(
      of([
        {
          id: 'u1',
          code: 'KG',
          name: 'Kg',
          dimension: 'MASS',
          precision: 3,
          baseUnitId: null,
          factor: null,
          version: 1,
        },
        {
          id: 'u3',
          code: 'L',
          name: 'Litro',
          dimension: 'VOLUME',
          precision: 3,
          baseUnitId: null,
          factor: null,
          version: 1,
        },
      ]),
    );
    settings['convert']!.mockReturnValue(
      throwError(() =>
        apiError(422, 'VALIDATION_ERROR', 'Verifique os campos indicados.', [
          {
            path: 'to',
            code: 'INCOMPATIBLE_DIMENSIONS',
            message: 'KG (MASS) não converte para L (VOLUME).',
          } as never,
        ]),
      ),
    );
    const f = await render(TenantSettings);
    await openTab(f, 'Unidades');
    await type(f, 'De', 'KG');
    await type(f, 'Para', 'L');
    await click(f, 'Converter');
    expect(text(f)).toContain('KG (MASS) não converte para L (VOLUME).');
  });

  it('sequences: previews without consuming and creates', async () => {
    const f = await render(TenantSettings);
    await openTab(f, 'Sequências');
    await click(f, 'Nova sequência');
    await type(f, 'Tipo de documento', 'INVOICE');
    await type(f, 'Série', 'A');
    await type(f, 'Modelo do prefixo', 'FT {SERIES}/{YYYY}/');
    await click(f, 'Pré-visualizar');
    expect(settings['previewSequence']).toHaveBeenCalledWith({
      organizationId: 'o1',
      series: 'A',
      branchId: null,
      prefixTemplate: 'FT {SERIES}/{YYYY}/',
      padding: 6,
      nextValue: '1',
    });
    expect(text(f)).toContain('FT A/2026/000001');
    expect(settings['createSequence']).not.toHaveBeenCalled(); // a pré-visualização não cria nada
    await click(f, 'Criar');
    expect(settings['createSequence']).toHaveBeenCalledWith({
      organizationId: 'o1',
      branchId: null,
      documentType: 'INVOICE',
      series: 'A',
      period: 'ALL',
      prefixTemplate: 'FT {SERIES}/{YYYY}/',
      nextValue: '1',
      padding: 6,
    });
  });

  it('sequences: the next number cannot go down (server message shown on the field)', async () => {
    const seq: SequenceDto = {
      id: 's1',
      organizationId: 'o1',
      branchId: null,
      documentType: 'INVOICE',
      series: 'A',
      period: 'ALL',
      prefixTemplate: 'FT {SERIES}/',
      nextValue: '41',
      padding: 6,
      version: 3,
    };
    settings['listSequences']!.mockReturnValue(of([seq]));
    settings['updateSequence']!.mockReturnValue(
      throwError(() =>
        apiError(422, 'VALIDATION_ERROR', 'Verifique', [
          {
            path: 'nextValue',
            code: 'NEXT_VALUE_DECREASE',
            message: 'O próximo número não pode diminuir.',
          } as never,
        ]),
      ),
    );
    const f = await render(TenantSettings);
    await openTab(f, 'Sequências');
    expect(text(f)).toContain('41');
    await click(f, 'Alterar');
    await type(f, 'Próximo número', '10');
    await click(f, 'Guardar');
    expect(settings['updateSequence']).toHaveBeenCalledWith('s1', {
      expectedVersion: 3,
      prefixTemplate: 'FT {SERIES}/',
      padding: 6,
      nextValue: '10',
    });
    expect(text(f)).toContain('O próximo número não pode diminuir.');
  });

  it('without organizations, taxes and sequences explain why there is nothing to show', async () => {
    TestBed.resetTestingModule();
    configure([
      { provide: SettingsApi, useValue: settings },
      {
        provide: OrganizationApi,
        useValue: { listOrganizations: vi.fn(() => of([])), listUnits: vi.fn(() => of([])) },
      },
    ]);
    ['tenant.settings.read', 'organization.units.read'].forEach((p) => granted.add(p));
    const f = await render(TenantSettings);
    await openTab(f, 'Impostos');
    expect(text(f)).toContain('Sem organizações');
    await openTab(f, 'Sequências');
    expect(text(f)).toContain('Sem organizações');
  });
});
