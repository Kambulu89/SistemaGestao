import { Component } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import { RouterTestingHarness } from '@angular/router/testing';
import { BreadcrumbService } from './breadcrumb.service';

@Component({ template: '' })
class Page {}

describe('BreadcrumbService', () => {
  beforeEach(() => {
    TestBed.configureTestingModule({
      providers: [
        provideRouter([
          {
            path: 'crm/customers',
            data: { breadcrumb: 'Clientes' },
            // A rota filha vazia herda `data` do pai, mas não deve repetir a migalha.
            children: [{ path: '', component: Page }],
          },
          { path: 'users', component: Page, data: { breadcrumb: 'Utilizadores' } },
          { path: 'plain', component: Page },
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
});
