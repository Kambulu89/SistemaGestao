import { type Type } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import { firstValueFrom } from 'rxjs';
import { DynamicEntityRegistryService } from '../../../core/dynamic/entity-registry.service';
import { TenantContextService } from '../../../core/tenant-context/tenant-context.service';
import { loginAs, setupMockBackend } from '../../../core/testing/test-backend';
import { EntityAdminDetailPage } from './entity-admin-detail-page';
import { EntityAdminListPage } from './entity-admin-list-page';

async function render(
  component: Type<unknown>,
  email: string,
  slug: string,
  inputs: Record<string, unknown> = {},
) {
  await loginAs(email);
  await firstValueFrom(TestBed.inject(TenantContextService).activate(slug));
  await firstValueFrom(TestBed.inject(DynamicEntityRegistryService).ensureLoaded());
  const fixture = TestBed.createComponent(component);
  for (const [key, value] of Object.entries(inputs)) fixture.componentRef.setInput(key, value);
  await fixture.whenStable();
  fixture.detectChanges();
  return fixture.nativeElement as HTMLElement;
}

describe('Core Dinâmico: administração (só leitura)', () => {
  beforeEach(() => {
    setupMockBackend();
    TestBed.configureTestingModule({ providers: [provideRouter([])] });
  });

  it('lists the entities of the tenant with scope, version and integrity', async () => {
    const el = await render(EntityAdminListPage, 'frota@demo.pt', 'transportes-atlas');
    const rows = [...el.querySelectorAll('tbody tr')].map((r) =>
      r.textContent?.replace(/\s+/g, ' ').trim(),
    );
    expect(rows).toHaveLength(3);
    expect(rows.find((r) => r?.startsWith('Viaturas'))).toContain('v2');
    expect(rows.find((r) => r?.startsWith('Notas'))).toContain('Global');
    expect(rows.every((r) => r?.includes('Íntegra'))).toBe(true);
  });

  it('another tenant only sees the global entity', async () => {
    const el = await render(EntityAdminListPage, 'escola@demo.pt', 'escola-horizonte');
    expect([...el.querySelectorAll('tbody tr')]).toHaveLength(1);
    expect(el.textContent).toContain('Notas');
    expect(el.textContent).not.toContain('Viaturas');
  });

  describe('detalhe da Viatura', () => {
    let el: HTMLElement;
    beforeEach(async () => {
      el = await render(EntityAdminDetailPage, 'frota@demo.pt', 'transportes-atlas', {
        entityKey: 'vehicle',
      });
    });

    it('describes the fields, including rules in plain language', () => {
      const text = el.querySelector('#sec-fields')!.parentElement!.textContent!;
      expect(text).toContain('Matrícula');
      expect(text).toContain('Único por tenant (verificado no servidor)');
      expect(text).toContain('Valor mínimo 0');
      expect(text).toContain('Opções: Gasolina, Gasóleo, Eléctrico, Híbrido');
    });

    it('shows the workflow with states, approvals and the ABAC policy', () => {
      const text = el.textContent!;
      expect(text).toContain('Enviar para manutenção');
      expect(text).toContain('Disponível');
      expect(text).toContain('aprovação (entities.vehicle.approve)');
      expect(text).toContain('vehicle.maintenance.finished');
      expect(text).toContain('Negar «eliminar» quando Estado ≠ Inactiva');
    });

    it('lists the IAM permission of every operation', () => {
      const text = el.querySelector('#sec-permissions')!.parentElement!.textContent!;
      for (const op of ['read', 'create', 'update', 'delete', 'export', 'approve', 'transition']) {
        expect(text).toContain(`entities.vehicle.${op}`);
      }
    });

    it('shows the version history with the compatibility diff (v1 → v2)', () => {
      const rows = [
        ...el.querySelector('#sec-versions')!.parentElement!.querySelectorAll('tbody tr'),
      ].map((r) => r.textContent!.replace(/\s+/g, ' '));
      expect(rows[0]).toContain('v2');
      expect(rows[0]).toContain('Campo acrescentado.');
      expect(rows[1]).toContain('v1');
      expect(rows[1]).toContain('Arquivada');
      expect(rows[1]).toContain('Versão inicial.');
    });

    it('previews the generated create form without actions', () => {
      const preview = el.querySelector('#sec-preview')!.parentElement!;
      expect(
        [...preview.querySelectorAll('label')].map((l) => l.textContent?.replace('*', '').trim()),
      ).toContain('Matrícula');
      expect(preview.querySelector('button[type=submit]')).toBeNull();
    });

    it('does not report integrity problems', () => {
      expect(el.textContent).not.toContain('Integridade da definição');
    });
  });

  it('describes a definition with conditional rules in plain language (Condutor)', async () => {
    const el = await render(EntityAdminDetailPage, 'frota@demo.pt', 'transportes-atlas', {
      entityKey: 'driver',
    });
    expect(el.textContent).toContain(
      'Quando Categoria em (C (pesados de mercadorias), D (pesados de passageiros))',
    );
    expect(el.textContent).toContain('Referência a «vehicle»');
    expect(el.textContent).toContain('Esta entidade não tem estados.');
  });

  it('says so for an unknown entity', async () => {
    const el = await render(EntityAdminDetailPage, 'frota@demo.pt', 'transportes-atlas', {
      entityKey: 'ghost',
    });
    expect(el.textContent).toContain('Entidade não encontrada');
  });
});
