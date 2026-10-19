import { TestBed } from '@angular/core/testing';
import { firstValueFrom } from 'rxjs';
import { moduleId } from '../../../core/modules/define-module';
import { TenantContextService } from '../../../core/tenant-context/tenant-context.service';
import { loginAs, setupMockBackend } from '../../../core/testing/test-backend';
import { ModuleScaffold } from './module-scaffold';

async function render(email: string, slug: string, code: string) {
  await loginAs(email);
  await firstValueFrom(TestBed.inject(TenantContextService).activate(slug));
  const fixture = TestBed.createComponent(ModuleScaffold);
  fixture.componentRef.setInput('moduleId', moduleId(code));
  await fixture.whenStable();
  return fixture.nativeElement as HTMLElement;
}

describe('ModuleScaffold', () => {
  beforeEach(() => setupMockBackend());

  it('shows module metadata, features, settings and permission status', async () => {
    const el = await render('escola@demo.pt', 'escola-horizonte', 'crm.customers');
    expect(el.querySelector('h1')?.textContent).toContain('Clientes e contactos');
    expect(el.textContent).toContain('Beta');
    expect(el.textContent).toContain('Importação de contactos');
    expect(el.textContent).toContain('Disponível');
    expect(el.textContent).toContain('Exigir NIF');
    expect(el.textContent).toContain('crm.customers.read');
  });

  it('flags a missing dependency', async () => {
    const el = await render('multi@demo.pt', 'clinica-vida', 'sales.billing');
    expect(el.textContent).toContain('Orçamentos e vendas');
    expect(el.textContent).toContain('Em falta');
  });
});
