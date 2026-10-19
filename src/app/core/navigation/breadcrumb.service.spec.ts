import { Component, inject } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { InjectionToken } from '@angular/core';
import { type ActivatedRouteSnapshot, provideRouter } from '@angular/router';
import { RouterTestingHarness } from '@angular/router/testing';
import { BreadcrumbService } from './breadcrumb.service';

const LABELS = new InjectionToken<{ prefix: string }>('LABELS');

@Component({ template: '' })
class Page {}

describe('BreadcrumbService', () => {
  beforeEach(() => {
    TestBed.configureTestingModule({
      providers: [
        { provide: LABELS, useValue: { prefix: 'Entidade' } },
        provideRouter([
          {
            path: 'crm/customers',
            data: { breadcrumb: 'Clientes' },
            // A rota filha vazia herda `data` do pai, mas não deve repetir a migalha.
            children: [{ path: '', component: Page }],
          },
          { path: 'users', component: Page, data: { breadcrumb: 'Utilizadores' } },
          { path: 'plain', component: Page },
          {
            path: 'dyn/:name',
            // Rótulo calculado em contexto de injecção, a partir dos parâmetros da rota.
            data: {
              breadcrumb: (route: ActivatedRouteSnapshot) =>
                `${inject(LABELS).prefix} ${route.paramMap.get('name')}`,
            },
            component: Page,
          },
          { path: 'hidden', component: Page, data: { breadcrumb: () => null } },
        ]),
      ],
    });
  });

  it('builds one crumb per route that declares a label, with accumulated paths', async () => {
    const harness = await RouterTestingHarness.create();
    await harness.navigateByUrl('/users');
    expect(TestBed.inject(BreadcrumbService).breadcrumbs()).toEqual([
      { label: 'Utilizadores', path: '/users' },
    ]);
  });

  it('does not duplicate the crumb of an inherited empty-path child', async () => {
    const harness = await RouterTestingHarness.create();
    await harness.navigateByUrl('/crm/customers');
    expect(TestBed.inject(BreadcrumbService).breadcrumbs()).toEqual([
      { label: 'Clientes', path: '/crm/customers' },
    ]);
  });

  it('is empty for routes without a label', async () => {
    const harness = await RouterTestingHarness.create();
    await harness.navigateByUrl('/plain');
    expect(TestBed.inject(BreadcrumbService).breadcrumbs()).toEqual([]);
  });

  it('accepts a function label resolved with injection and route params', async () => {
    const harness = await RouterTestingHarness.create();
    await harness.navigateByUrl('/dyn/vehicle');
    expect(TestBed.inject(BreadcrumbService).breadcrumbs()).toEqual([
      { label: 'Entidade vehicle', path: '/dyn/vehicle' },
    ]);
  });

  it('omits the crumb when the function returns null', async () => {
    const harness = await RouterTestingHarness.create();
    await harness.navigateByUrl('/hidden');
    expect(TestBed.inject(BreadcrumbService).breadcrumbs()).toEqual([]);
  });
});
