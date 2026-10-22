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

  it('marks every catalog module as provisional entitlements (until plans and modules exist)', async () => {
    const promise = firstValueFrom(gateway.loadContext('t1'));
    http.expectOne(`${API}/context`).flush(
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
      }),
    );
    const context = await promise;
    expect(context.subscription.planCode).toBe('provisional');
    expect(context.modules.every((m) => m.active)).toBe(true);
    expect(context.permissions).toEqual([]);
  });
});
