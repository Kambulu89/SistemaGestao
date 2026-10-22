import { signal, type Type } from '@angular/core';
import { type ComponentFixture, TestBed } from '@angular/core/testing';
import { of, throwError } from 'rxjs';
import type { ApiError } from '../../core/api/api-error.model';
import { MODULE_MANIFESTS } from '../../core/modules/module-manifests.token';
import { PermissionService } from '../../core/permissions/permission.service';
import { setupMockBackend } from '../../core/testing/test-backend';
import { ALL_MODULE_MANIFESTS } from '../../module-catalog';
import { ModuleCatalogPage } from './catalog/module-catalog-page';
import { PlatformDashboard } from './dashboard/platform-dashboard';
import {
  PlatformApi,
  type PlanVersionDto,
  type PlatformSubscriptionView,
  type PlatformTenantDto,
  type ProvisioningStateDto,
} from './data-access/platform.api';
import { Plans } from './plans/plans';
import { Subscriptions } from './subscriptions/subscriptions';
import { Tenants } from './tenants/tenants';

const apiError = (status: number, code: string, message: string, fieldErrors = []): ApiError => ({
  status,
  code,
  message,
  fieldErrors,
});

const tenant = (over: Partial<PlatformTenantDto> = {}): PlatformTenantDto => ({
  id: 't1',
  code: 'demo_a',
  name: 'Demo A',
  status: 'ACTIVE',
  plan: { code: 'demo_basic', revision: 1, status: 'ACTIVE' },
  ...over,
});

const plan = (over: Partial<PlanVersionDto> = {}): PlanVersionDto => ({
  planCode: 'demo_basic',
  revision: 1,
  name: 'Demo Básico',
  price: '49.9000',
  currency: 'AOA',
  billingInterval: 'MONTH',
  limits: { members: 10 },
  entitlements: { modules: ['crm'], features: [] },
  status: 'PUBLISHED',
  publishedAt: '2026-01-01T00:00:00.000Z',
  ...over,
});

const state = (over: Partial<ProvisioningStateDto> = {}): ProvisioningStateDto => ({
  tenant: tenant({ id: 't9', code: 'novo', name: 'Novo' }),
  done: ['TENANT', 'SUBSCRIPTION', 'ADMIN_ROLE', 'ORGANIZATION', 'ADMIN_INVITATION', 'ACTIVATION'],
  organizations: 1,
  pendingInvitations: 1,
  created: true,
  ...over,
});

const subscriptionView = (
  over: Partial<PlatformSubscriptionView> = {},
): PlatformSubscriptionView => ({
  plan: plan(),
  subscription: {
    status: 'ACTIVE',
    startsAt: '2026-01-01T00:00:00.000Z',
    periodEnd: '2026-02-01T00:00:00.000Z',
    trialEnd: null,
    graceEnd: null,
    adequacyUntil: null,
    cancelAtPeriodEnd: false,
  },
  entitled: true,
  usage: [{ metric: 'members', used: 3, limit: 10, blocked: false }],
  history: [
    {
      kind: 'ASSIGNED',
      fromStatus: null,
      toStatus: 'ACTIVE',
      adequacyUntil: null,
      occurredAt: '2026-01-01T00:00:00.000Z',
    },
  ],
  ...over,
});

type Stub = Record<keyof PlatformApi, ReturnType<typeof vi.fn>>;

function stubApi(): Stub {
  return {
    listTenants: vi.fn(() =>
      of([
        tenant(),
        tenant({ id: 't2', code: 'demo_b', name: 'Demo B', status: 'SUSPENDED', plan: null }),
      ]),
    ),
    provision: vi.fn(() => of(state())),
    tenantState: vi.fn(() => of(state({ created: undefined }))),
    suspend: vi.fn(() => of(tenant({ status: 'SUSPENDED' }))),
    resume: vi.fn(() => of(tenant())),
    listPlans: vi.fn(() => of([plan(), plan({ revision: 2, status: 'DRAFT', publishedAt: null })])),
    createPlan: vi.fn(() => of(plan({ revision: 3, status: 'DRAFT' }))),
    publishPlan: vi.fn(() => of(plan())),
    retirePlan: vi.fn(() => of(plan({ status: 'RETIRED' }))),
    subscription: vi.fn(() => of(subscriptionView())),
    assign: vi.fn(() => of({})),
    changePlan: vi.fn(() => of({})),
    setSubscriptionStatus: vi.fn(() => of({})),
  } as unknown as Stub;
}

describe('platform pages', () => {
  let api: Stub;
  let granted: Set<string>;

  beforeEach(() => {
    setupMockBackend();
    api = stubApi();
    granted = new Set(['platform.tenant.manage', 'platform.billing.manage']);
    TestBed.configureTestingModule({
      providers: [
        { provide: MODULE_MANIFESTS, useValue: ALL_MODULE_MANIFESTS },
        { provide: PlatformApi, useValue: api },
        { provide: PermissionService, useValue: { can: (p: string) => granted.has(p) } },
      ],
    });
  });

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
  async function click(f: ComponentFixture<unknown>, label: string): Promise<void> {
    const target = button(f, label);
    expect(target, `botão "${label}"`).toBeDefined();
    target!.click();
    await f.whenStable();
    f.detectChanges();
  }
  async function type(f: ComponentFixture<unknown>, label: string, value: string): Promise<void> {
    const field = [...(f.nativeElement as HTMLElement).querySelectorAll('label')].find((l) =>
      l.textContent?.includes(label),
    );
    const input = (field
      ?.closest('app-input, app-textarea, app-select')
      ?.querySelector('input, textarea, select') ??
      document.getElementById(field?.getAttribute('for') ?? '')) as HTMLInputElement | null;
    expect(input, `campo "${label}"`).not.toBeNull();
    input!.value = value;
    input!.dispatchEvent(new Event(input!.tagName === 'SELECT' ? 'change' : 'input'));
    f.detectChanges();
  }

  it('catalog lists all 46 capabilities in 19 groups (code manifests, no API)', async () => {
    const el = (await render(ModuleCatalogPage)).nativeElement as HTMLElement;
    expect(el.querySelectorAll('table')).toHaveLength(19);
    expect(el.querySelectorAll('tbody tr')).toHaveLength(46);
    expect(el.textContent).toContain('46 capacidades em 19 grupos');
  });

  describe('dashboard', () => {
    it('shows real counts from the tenants API and the code catalog indicators', async () => {
      const f = await render(PlatformDashboard);
      expect(api.listTenants).toHaveBeenCalledOnce();
      const t = text(f);
      expect(t).toContain('Tenants activos');
      expect(t).toContain('2 no total');
      expect(t).toContain('Suspensos');
      expect(t).toContain('46'); // catálogo do código
      expect(t).not.toContain('demonstração');
    });

    it('does not call the tenants API without platform.tenant.manage', async () => {
      granted = new Set(['platform.billing.manage']);
      const f = await render(PlatformDashboard);
      expect(api.listTenants).not.toHaveBeenCalled();
      expect(text(f)).not.toContain('Tenants activos');
    });
  });

  describe('tenants', () => {
    it('lists tenants with plan and state', async () => {
      const f = await render(Tenants);
      const t = text(f);
      expect(t).toContain('Demo A');
      expect(t).toContain('demo_basic · r1');
      expect(t).toContain('Sem plano');
      expect(t).toContain('Suspenso');
      expect(button(f, 'Suspender')).toBeDefined(); // Demo A (activo)
      expect(button(f, 'Reactivar')).toBeDefined(); // Demo B (suspenso)
    });

    it('shows an error when loading fails', async () => {
      api.listTenants.mockReturnValue(
        throwError(() => apiError(403, 'PLATFORM_PERMISSION_DENIED', 'Sem permissão')),
      );
      const f = await render(Tenants);
      expect(text(f)).toContain('Não foi possível carregar os tenants');
    });

    it('requires a reason to suspend and sends it', async () => {
      const f = await render(Tenants);
      await click(f, 'Suspender');
      await click(f, 'Confirmar');
      expect(api.suspend).not.toHaveBeenCalled();
      await type(f, 'Motivo', 'Falta de pagamento');
      await click(f, 'Confirmar');
      expect(api.suspend).toHaveBeenCalledWith('t1', 'Falta de pagamento');
      expect(text(f)).toContain('Demo A suspenso.');
      expect(api.listTenants).toHaveBeenCalledTimes(2); // lista recarregada
    });

    it('provisions a tenant and shows the checklist; the admin is invited, no password asked', async () => {
      const f = await render(Tenants);
      await click(f, 'Novo tenant');
      expect(text(f)).not.toContain('Palavra-passe');
      await type(f, 'Identificador', 'novo');
      await type(f, 'Nome', 'Novo');
      await type(f, 'Email do administrador', 'admin@novo.pt');
      await type(f, 'Plano', 'demo_basic');
      await click(f, 'Provisionar');
      expect(api.provision).toHaveBeenCalledWith({
        code: 'novo',
        name: 'Novo',
        adminEmail: 'admin@novo.pt',
        planCode: 'demo_basic',
        trialDays: undefined,
      });
      const t = text(f);
      expect(t).toContain('Tenant Novo criado');
      expect(t).toContain('Convite ao administrador');
      expect(t).toContain('Feito');
    });

    it('reports a repeated provisioning as resumed, and a failure keeps the list refreshed', async () => {
      api.provision.mockReturnValueOnce(of(state({ created: false })));
      const f = await render(Tenants);
      await click(f, 'Novo tenant');
      await type(f, 'Identificador', 'novo');
      await type(f, 'Nome', 'Novo');
      await type(f, 'Email do administrador', 'admin@novo.pt');
      await type(f, 'Plano', 'demo_basic');
      await click(f, 'Provisionar');
      expect(text(f)).toContain('já existia; o provisionamento foi retomado');

      api.provision.mockReturnValueOnce(
        throwError(() => apiError(404, 'NOT_FOUND', 'Plano não encontrado.')),
      );
      await click(f, 'Fechar');
      await click(f, 'Novo tenant');
      await type(f, 'Identificador', 'outro');
      await type(f, 'Nome', 'Outro');
      await type(f, 'Email do administrador', 'a@b.pt');
      await type(f, 'Plano', 'demo_basic');
      const before = api.listTenants.mock.calls.length;
      await click(f, 'Provisionar');
      expect(text(f)).toContain('O plano indicado não existe ou não está publicado.');
      expect(api.listTenants.mock.calls.length).toBe(before + 1);
    });

    it('validates the provisioning form before calling the API', async () => {
      const f = await render(Tenants);
      await click(f, 'Novo tenant');
      await type(f, 'Identificador', 'Inválido!');
      await click(f, 'Provisionar');
      expect(api.provision).not.toHaveBeenCalled();
    });
  });

  describe('plans', () => {
    it('lists versions with price as a string, limits and state', async () => {
      const f = await render(Plans);
      const t = text(f);
      expect(t).toContain('49.9000 AOA / mês');
      expect(t).toContain('Publicado');
      expect(t).toContain('Rascunho');
      expect(button(f, 'Retirar')).toBeDefined();
      expect(button(f, 'Publicar')).toBeDefined();
    });

    it('publishes a draft and retires a published version', async () => {
      const f = await render(Plans);
      await click(f, 'Publicar');
      expect(api.publishPlan).toHaveBeenCalledWith('demo_basic', 2);
      await click(f, 'Retirar');
      expect(api.retirePlan).toHaveBeenCalledWith('demo_basic', 1);
    });

    it('reloads and explains when a transition is refused', async () => {
      api.publishPlan.mockReturnValue(
        throwError(() =>
          apiError(409, 'INVALID_STATE_TRANSITION', 'Só uma versão DRAFT pode passar a PUBLISHED'),
        ),
      );
      const f = await render(Plans);
      const before = api.listPlans.mock.calls.length;
      await click(f, 'Publicar');
      expect(text(f)).toContain('Só uma versão DRAFT');
      expect(api.listPlans.mock.calls.length).toBe(before + 1);
    });

    it('creates a draft revision with unlimited members and licensed codes', async () => {
      const f = await render(Plans);
      await click(f, 'Nova revisão');
      await type(f, 'Código do plano', 'pro');
      await type(f, 'Nome', 'Profissional');
      await type(f, 'Preço', '99.5');
      const unlimited = (f.nativeElement as HTMLElement).querySelector(
        'app-checkbox input',
      ) as HTMLInputElement;
      unlimited.checked = true;
      unlimited.dispatchEvent(new Event('change'));
      f.detectChanges();
      await type(f, 'Módulos licenciados', 'crm, sales');
      await click(f, 'Criar rascunho');
      expect(api.createPlan).toHaveBeenCalledWith({
        planCode: 'pro',
        name: 'Profissional',
        currency: 'AOA',
        price: '99.5',
        billingInterval: 'MONTH',
        limits: { members: null },
        entitlements: { modules: ['crm', 'sales'], features: [] },
      });
      expect(text(f)).toContain('Revisão 3 de demo_basic criada em rascunho.');
    });

    it('rejects an invalid price locally', async () => {
      const f = await render(Plans);
      await click(f, 'Nova revisão');
      await type(f, 'Código do plano', 'pro');
      await type(f, 'Nome', 'Pro');
      await type(f, 'Preço', '10,5');
      await click(f, 'Criar rascunho');
      expect(api.createPlan).not.toHaveBeenCalled();
    });
  });

  describe('subscriptions', () => {
    it('lists tenants with plan and subscription state', async () => {
      const f = await render(Subscriptions);
      const t = text(f);
      expect(t).toContain('demo_basic · r1');
      expect(t).toContain('Activa');
      expect(t).toContain('Sem plano');
    });

    it('shows the contracted plan, price, usage and history', async () => {
      const f = await render(Subscriptions);
      await click(f, 'Gerir');
      expect(api.subscription).toHaveBeenCalledWith('t1');
      const t = text(f);
      expect(t).toContain('49.9000 AOA / mês');
      expect(t).toContain('Membros: 3 / 10');
      expect(t).toContain('Plano atribuído');
    });

    it('offers to assign a plan when the tenant has none', async () => {
      api.subscription.mockReturnValue(
        throwError(() => apiError(404, 'NOT_FOUND', 'O tenant não tem assinatura.')),
      );
      const f = await render(Subscriptions);
      const manage = [...(f.nativeElement as HTMLElement).querySelectorAll('button')].filter((b) =>
        b.textContent?.includes('Gerir'),
      )[1] as HTMLButtonElement;
      manage.click();
      await f.whenStable();
      f.detectChanges();
      expect(text(f)).toContain('ainda não tem subscrição');
      const select = (f.nativeElement as HTMLElement).querySelector(
        'app-dialog select',
      ) as HTMLSelectElement;
      select.value = 'demo_basic:1';
      select.dispatchEvent(new Event('change'));
      await click(f, 'Atribuir plano');
      expect(api.assign).toHaveBeenCalledWith('t2', {
        planCode: 'demo_basic',
        revision: 1,
        trialDays: undefined,
      });
    });

    it('explains an exceeded downgrade and lets the operator retry with an adequacy period', async () => {
      api.changePlan.mockReturnValueOnce(
        throwError(() =>
          apiError(
            409,
            'PLAN_LIMITS_EXCEEDED',
            'O consumo actual excede os limites do novo plano',
            [
              {
                path: 'limits.members',
                code: 'LIMIT_EXCEEDED',
                message: 'Em uso: 3; limite do novo plano: 1.',
              } as never,
            ],
          ),
        ),
      );
      const f = await render(Subscriptions);
      await click(f, 'Gerir');
      const select = (f.nativeElement as HTMLElement).querySelectorAll(
        'app-dialog select',
      )[0] as HTMLSelectElement;
      select.value = 'demo_basic:1';
      select.dispatchEvent(new Event('change'));
      await click(f, 'Mudar plano');
      const t = text(f);
      expect(t).toContain('Indique os dias de adequação');
      expect(t).toContain('Em uso: 3; limite do novo plano: 1.');

      await type(f, 'Dias de adequação', '30');
      await click(f, 'Mudar plano');
      expect(api.changePlan).toHaveBeenLastCalledWith('t1', {
        planCode: 'demo_basic',
        revision: 1,
        adequacyDays: 30,
      });
      expect(text(f)).toContain('Plano alterado.');
    });

    it('changes the subscription state with a grace period for PAST_DUE', async () => {
      const f = await render(Subscriptions);
      await click(f, 'Gerir');
      const statusSelect = [
        ...(f.nativeElement as HTMLElement).querySelectorAll('app-dialog select'),
      ].at(-1) as HTMLSelectElement;
      statusSelect.value = 'PAST_DUE';
      statusSelect.dispatchEvent(new Event('change'));
      f.detectChanges();
      await type(f, 'Dias de tolerância', '5');
      await click(f, 'Aplicar estado');
      expect(api.setSubscriptionStatus).toHaveBeenCalledWith('t1', {
        status: 'PAST_DUE',
        graceDays: 5,
      });
    });
  });
});

void signal;
