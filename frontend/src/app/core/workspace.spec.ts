import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { TestBed } from '@angular/core/testing';
import { Workspace } from './workspace';

describe('Workspace', () => {
  beforeEach(() => {
    localStorage.clear();
    TestBed.configureTestingModule({
      providers: [provideHttpClient(), provideHttpClientTesting()],
    });
  });

  it('carrega contexto e permissões e guarda a escolha', async () => {
    const workspace = TestBed.inject(Workspace);
    const http = TestBed.inject(HttpTestingController);
    const promise = workspace.select('t1');
    http.expectOne('/api/v1/context').flush({
      data: {
        tenant: { id: 't1', name: 'A' },
        membershipId: 'm',
        subscriptionStatus: 'ACTIVE',
        features: [{ code: 'approvals', limit: null }],
      },
    });
    http.expectOne('/api/v1/me/permissions').flush({ data: { tenant: ['audit.read'], own: [] } });
    await promise;
    expect(workspace.can('audit.read')).toBe(true);
    expect(workspace.can('roles.read')).toBe(false);
    expect(workspace.has('approvals')).toBe(true);
    expect(localStorage.getItem('sg.tenantId')).toBe('t1');
  });

  it('sem acesso à empresa limpa a escolha e não guarda permissões', async () => {
    localStorage.setItem('sg.tenantId', 'antiga');
    const workspace = TestBed.inject(Workspace);
    const http = TestBed.inject(HttpTestingController);
    const promise = workspace.select('t2');
    http
      .expectOne('/api/v1/context')
      .flush(
        { error: { code: 'TENANT_ACCESS_DENIED', message: 'Sem acesso', details: [] } },
        { status: 403, statusText: 'Forbidden' },
      );
    http
      .match('/api/v1/me/permissions')
      .forEach((r) => r.flush({ data: { tenant: ['x'], own: [] } }));
    await expect(promise).rejects.toBeTruthy();
    expect(workspace.tenantId()).toBeNull();
    expect(workspace.context()).toBeNull();
    expect(workspace.permissions().size).toBe(0);
    expect(localStorage.getItem('sg.tenantId')).toBeNull();
  });
});
