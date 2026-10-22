import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { TestBed } from '@angular/core/testing';
import { firstValueFrom } from 'rxjs';
import { ALL_MODULE_MANIFESTS } from '../../module-catalog';
import { APP_ENVIRONMENT } from '../config/app-environment';
import { MODULE_MANIFESTS } from '../modules/module-manifests.token';
import { HttpTenantGateway } from './http-tenant.gateway';

const API = 'http://api.test/api/v1';
const envelope = (data: unknown) => ({ data, meta: { correlationId: 'c-1' } });

describe('HttpTenantGateway', () => {
  let gateway: HttpTenantGateway;
  let http: HttpTestingController;

  beforeEach(() => {
    TestBed.configureTestingModule({
      providers: [
        { provide: APP_ENVIRONMENT, useValue: { apiUrl: API } },
        { provide: MODULE_MANIFESTS, useValue: ALL_MODULE_MANIFESTS },
        provideHttpClient(),
        provideHttpClientTesting(),
        HttpTenantGateway,
      ],
    });
    gateway = TestBed.inject(HttpTenantGateway);
    http = TestBed.inject(HttpTestingController);
  });

  afterEach(() => http.verify());

  it('lists the tenants of the user (code becomes the URL slug)', async () => {
    const promise = firstValueFrom(gateway.listMemberships());
    http.expectOne(`${API}/me/tenants`).flush(
      envelope([
        { id: 't1', code: 'demo_a', name: 'Demo A', status: 'ACTIVE' },
        { id: 't2', code: 'demo_b', name: 'Demo B', status: 'SUSPENDED' },
      ]),
    );
    const list = await promise;
    expect(list.map((m) => [m.tenant.slug, m.tenant.status])).toEqual([
      ['demo_a', 'active'],
      ['demo_b', 'suspended'],
    ]);
  });

  it('loads the context with an explicit tenant selector and translates permissions', async () => {
    const promise = firstValueFrom(gateway.loadContext('t1'));
    const req = http.expectOne(`${API}/context`);
    expect(req.request.headers.get('X-Tenant-Id')).toBe('t1');
    req.flush(
      envelope({
        tenant: {
          id: 't1',
          code: 'demo_a',
          name: 'Demo A',
          status: 'ACTIVE',
          defaultLocale: 'pt-AO',
          timezone: 'Africa/Luanda',
        },
        locale: 'pt-AO',
        authorizationVersion: 4,
        permissions: [
          { code: 'iam.manage', unitScoped: false },
          { code: 'party.read', unitScoped: false },
        ],
        modules: [],
        features: [],
      }),
    );
    const context = await promise;
    expect(context.tenant).toMatchObject({
      slug: 'demo_a',
      timeZone: 'Africa/Luanda',
      locale: 'pt-AO',
    });
    expect(context.authorizationVersion).toBe(4);
    expect(context.permissions).toEqual(
      expect.arrayContaining([
        'iam.manage',
        'iam.access-control.read',
        'iam.access-control.manage',
        'party.read',
      ]),
    );
  });

  const contextDto = (over: Record<string, unknown> = {}) =>
    envelope({
      tenant: {
        id: 't1',
        code: 'c',
        name: 'N',
        status: 'ACTIVE',
        defaultLocale: 'pt-AO',
        timezone: 'UTC',
      },
      locale: 'pt-AO',
      authorizationVersion: 1,
      permissions: [],
      modules: [],
      features: [],
      ...over,
    });

  it('has no business modules when the registry has none enabled (no provisional entitlements)', async () => {
    const promise = firstValueFrom(gateway.loadContext('t1'));
    http.expectOne(`${API}/context`).flush(contextDto());
    const context = await promise;
    expect(context.modules).toEqual([]);
    expect(context.subscription.moduleIds).toEqual([]);
    expect(context.permissions).toEqual([]);
    expect(context.featureFlags).toEqual({});
  });

  it('activates exactly the manifests of the enabled registry modules, with their effective features', async () => {
    const promise = firstValueFrom(gateway.loadContext('t1'));
    http.expectOne(`${API}/context`).flush(
      contextDto({
        modules: ['crm'],
        features: ['crm.customers.import'],
      }),
    );
    const context = await promise;
    const crm = ALL_MODULE_MANIFESTS.filter(
      (m) => m.kind === 'module' && m.code.startsWith('crm.'),
    );
    expect(crm.length).toBeGreaterThan(0);
    expect(context.modules.map((m) => m.moduleId).sort()).toEqual(crm.map((m) => m.id).sort());
    expect(context.subscription.moduleIds).toEqual(context.modules.map((m) => m.moduleId));
    expect(context.modules.every((m) => m.active)).toBe(true);
    const customers = context.modules.find((m) => m.moduleId === 'mod_crm_customers');
    expect(customers?.features).toEqual(['import']); // só a funcionalidade efectiva do servidor
    // Módulos de outros prefixos continuam fora.
    expect(context.modules.some((m) => !m.moduleId.startsWith('mod_crm_'))).toBe(false);
  });

  it('enriches the subscription with the plan and usage when the user can read it', async () => {
    const promise = firstValueFrom(gateway.loadContext('t1'));
    http
      .expectOne(`${API}/context`)
      .flush(contextDto({ permissions: [{ code: 'subscription.read' }] }));
    const req = http.expectOne(`${API}/tenant/subscription`);
    expect(req.request.headers.get('X-Tenant-Id')).toBe('t1');
    req.flush(
      envelope({
        plan: {
          code: 'demo_basic',
          revision: 1,
          name: 'Básico',
          price: '49.9000',
          currency: 'AOA',
          billingInterval: 'MONTH',
          limits: { members: 10 },
          entitlements: { modules: [], features: [] },
        },
        subscription: {
          status: 'PAST_DUE',
          entitled: true,
          startsAt: '2026-01-01T00:00:00.000Z',
          periodEnd: '2026-02-01T00:00:00.000Z',
          trialEnd: null,
          graceEnd: null,
          adequacyUntil: null,
          cancelAtPeriodEnd: false,
        },
        usage: [{ metric: 'members', used: 3, limit: 10, blocked: false }],
        history: [],
      }),
    );
    const { subscription } = await promise;
    expect(subscription).toMatchObject({
      planCode: 'demo_basic',
      status: 'past_due',
      renewsAt: '2026-02-01T00:00:00.000Z',
    });
    expect(subscription.limits).toEqual([
      { key: 'members', label: 'Membros', limit: 10, unit: 'membros', used: 3 },
    ]);
  });

  it('keeps a valid context when the subscription cannot be read (no plan yet, or no access)', async () => {
    const promise = firstValueFrom(gateway.loadContext('t1'));
    http
      .expectOne(`${API}/context`)
      .flush(contextDto({ permissions: [{ code: 'subscription.read' }] }));
    http
      .expectOne(`${API}/tenant/subscription`)
      .flush({ error: { code: 'NOT_FOUND', message: 'x' } }, { status: 404, statusText: 'x' });
    const context = await promise;
    expect(context.subscription.planCode).toBe('');
    expect(context.subscription.limits).toEqual([]);
  });

  it('does not ask for the subscription without the permission', async () => {
    const promise = firstValueFrom(gateway.loadContext('t1'));
    http.expectOne(`${API}/context`).flush(contextDto({ permissions: [{ code: 'party.read' }] }));
    await promise;
    http.expectNone(`${API}/tenant/subscription`);
  });
});
