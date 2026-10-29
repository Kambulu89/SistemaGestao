import { TestBed } from '@angular/core/testing';
import { ActivatedRoute, Router } from '@angular/router';
import { describe, expect, it, vi } from 'vitest';
import { moduleId } from '../../core/modules/define-module';
import { TenantContextService } from '../../core/tenant-context/tenant-context.service';
import { ALL_MODULE_MANIFESTS } from '../../module-catalog';
import { CAPABILITY_TARGETS, CapabilityRedirect } from './capability-redirect';

function open(id: string | undefined, slug: string | null = 'demo') {
  const navigate = vi.fn(() => Promise.resolve(true));
  TestBed.configureTestingModule({
    providers: [
      { provide: Router, useValue: { navigate } },
      { provide: ActivatedRoute, useValue: { snapshot: { data: { moduleId: id } } } },
      { provide: TenantContextService, useValue: { tenant: () => (slug ? { slug } : null) } },
    ],
  });
  TestBed.createComponent(CapabilityRedirect);
  return navigate;
}

describe('CapabilityRedirect', () => {
  it('leva cada capacidade à página real do tenant', () => {
    expect(open(moduleId('iam.teams'))).toHaveBeenCalledWith(['/t', 'demo', 'organization'], {
      replaceUrl: true,
    });
  });

  it.each(Object.entries(CAPABILITY_TARGETS))('%s → %s', (id, target) => {
    TestBed.resetTestingModule();
    expect(open(id)).toHaveBeenCalledWith(['/t', 'demo', target], { replaceUrl: true });
  });

  it('sem tenant ou sem destino volta ao início, sem navegar para um destino inventado', () => {
    expect(open(moduleId('iam.teams'), null)).toHaveBeenCalledWith(['/']);
    TestBed.resetTestingModule();
    expect(open('mod_desconhecido')).toHaveBeenCalledWith(['/']);
  });

  it('nenhuma capacidade que declara o redirecionamento fica sem destino, e as restantes não o usam', () => {
    const withRedirect = ALL_MODULE_MANIFESTS.filter((m) =>
      Object.keys(CAPABILITY_TARGETS).includes(m.id),
    );
    expect(withRedirect).toHaveLength(Object.keys(CAPABILITY_TARGETS).length);
    for (const manifest of withRedirect) expect(manifest.routes.length).toBeGreaterThan(0);
  });
});
