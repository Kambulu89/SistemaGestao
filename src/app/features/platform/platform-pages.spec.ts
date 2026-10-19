import { type Type } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { MODULE_MANIFESTS } from '../../core/modules/module-manifests.token';
import { setupMockBackend } from '../../core/testing/test-backend';
import { ALL_MODULE_MANIFESTS } from '../../module-catalog';
import { BillingGateway } from './billing/billing.gateway';
import { MockBillingGateway } from './billing/mock-billing.gateway';
import { ModuleCatalogPage } from './catalog/module-catalog-page';
import { PlatformDashboard } from './dashboard/platform-dashboard';
import { Plans } from './plans/plans';
import { Subscriptions } from './subscriptions/subscriptions';

async function render(component: Type<unknown>, until?: string): Promise<HTMLElement> {
  const fixture = TestBed.createComponent(component);
  const el = fixture.nativeElement as HTMLElement;
  await fixture.whenStable();
  if (until) {
    await vi.waitFor(() => {
      fixture.detectChanges();
      expect(el.querySelector(until)).not.toBeNull();
    });
  }
  return el;
}

describe('platform pages', () => {
  beforeEach(() => {
    setupMockBackend();
    TestBed.configureTestingModule({
      providers: [
        { provide: MODULE_MANIFESTS, useValue: ALL_MODULE_MANIFESTS },
        { provide: BillingGateway, useClass: MockBillingGateway },
      ],
    });
  });

  it('catalog lists all 46 capabilities in 19 groups', async () => {
    const el = await render(ModuleCatalogPage);
    expect(el.querySelectorAll('table')).toHaveLength(19);
    expect(el.querySelectorAll('tbody tr')).toHaveLength(46);
    expect(el.textContent).toContain('46 capacidades em 19 grupos');
    expect(el.textContent).toContain('Fundação');
    expect(el.textContent).toContain('crm.customers');
  });

  it('dashboard derives the catalog indicators from the registry', async () => {
    const el = await render(PlatformDashboard);
    expect(el.textContent).toContain('46');
    expect(el.textContent).toContain('35');
    expect(el.textContent).toContain('11');
  });

  it('plans page lists the plans with limits', async () => {
    const el = await render(Plans, 'tbody tr');
    expect(el.querySelectorAll('tbody tr')).toHaveLength(3);
    expect(el.textContent).toContain('Ilimitado');
  });

  it('subscriptions page paginates', async () => {
    const el = await render(Subscriptions, 'tbody tr');
    expect(el.querySelectorAll('tbody tr')).toHaveLength(8);
    expect(el.textContent).toContain('Escola Horizonte');
    expect(el.textContent).toContain('de 15');
  });
});
