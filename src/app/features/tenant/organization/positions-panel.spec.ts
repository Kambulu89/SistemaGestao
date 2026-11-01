import { TestBed } from '@angular/core/testing';
import { of } from 'rxjs';
import { describe, expect, it, vi } from 'vitest';
import { PermissionService } from '../../../core/permissions/permission.service';
import { OrganizationApi, type PositionDto, type UnitDto } from '../data-access/organization.api';
import { PositionsPanel, positionBody } from './positions-panel';

const UNITS = [
  { id: 'b1', organizationId: 'o1', code: 'SEDE', name: 'Sede', type: 'BRANCH' },
  { id: 'd1', organizationId: 'o1', code: 'RH', name: 'Recursos Humanos', type: 'DEPARTMENT' },
] as UnitDto[];

const POSITION: PositionDto = {
  id: 'p1',
  code: 'TEC-RH',
  name: 'Técnico de RH',
  description: null,
  jobFamily: null,
  category: null,
  hierarchyLevel: 4,
  departmentId: 'd1',
  parentId: null,
  responsibilities: null,
  competencies: ['Excel'],
  academicRequirements: null,
  recommendedExperience: null,
  status: 'ACTIVE',
  version: 2,
};

function configure(org: Record<string, unknown>, granted = ['organization.manage']) {
  TestBed.configureTestingModule({
    providers: [
      { provide: PermissionService, useValue: { can: (p: string) => granted.includes(p) } },
      { provide: OrganizationApi, useValue: org },
    ],
  });
}

async function settle(fixture: { detectChanges(): void; whenStable(): Promise<unknown> }) {
  fixture.detectChanges();
  await fixture.whenStable();
  fixture.detectChanges();
}

const button = (el: HTMLElement, label: string) =>
  [...el.querySelectorAll('button')].find((b) => b.textContent?.trim() === label);

describe('positionBody', () => {
  const draft = {
    code: 'X',
    name: ' Director ',
    departmentId: '',
    parentId: 'p0',
    hierarchyLevel: '2',
    jobFamily: '',
    category: 'Direcção',
    description: '',
    responsibilities: '',
    competencies: 'Liderança, Finanças\nNegociação;',
    academicRequirements: '',
    recommendedExperience: '',
  };

  it('normaliza texto, nível e competências', () => {
    const { body, error } = positionBody(draft);
    expect(error).toBeNull();
    expect(body).toMatchObject({
      name: 'Director',
      departmentId: null,
      parentId: 'p0',
      hierarchyLevel: 2,
      category: 'Direcção',
      jobFamily: null,
      competencies: ['Liderança', 'Finanças', 'Negociação'],
    });
  });

  it('recusa nível fora de 1–20 e designação vazia', () => {
    expect(positionBody({ ...draft, hierarchyLevel: '21' }).error).toContain('1 a 20');
    expect(positionBody({ ...draft, hierarchyLevel: '2.5' }).error).toContain('1 a 20');
    expect(positionBody({ ...draft, name: '  ' }).error).toContain('designação');
  });
});

describe('PositionsPanel', () => {
  it('lista com o departamento e desactiva com a versão esperada', async () => {
    const updatePosition = vi.fn(() => of(POSITION));
    configure({ listPositions: () => of([POSITION]), updatePosition });
    const fixture = TestBed.createComponent(PositionsPanel);
    fixture.componentRef.setInput('units', UNITS);
    await settle(fixture);
    await settle(fixture);
    const el = fixture.nativeElement as HTMLElement;
    expect(el.textContent).toContain('Técnico de RH');
    expect(el.textContent).toContain('Recursos Humanos');
    button(el, 'Desactivar')!.click();
    expect(updatePosition).toHaveBeenCalledWith(POSITION, { status: 'INACTIVE' });
  });

  it('só oferece departamentos, secções e equipas como departamento', async () => {
    configure({ listPositions: () => of([]) });
    const fixture = TestBed.createComponent(PositionsPanel);
    fixture.componentRef.setInput('units', UNITS);
    await settle(fixture);
    const options = (
      fixture.componentInstance as unknown as { departmentOptions(): { label: string }[] }
    ).departmentOptions();
    expect(options.map((o) => o.label)).toEqual(['RH — Recursos Humanos']);
  });

  it('sem organization.manage não mostra acções de escrita', async () => {
    configure({ listPositions: () => of([POSITION]) }, ['organization.read']);
    const fixture = TestBed.createComponent(PositionsPanel);
    fixture.componentRef.setInput('units', UNITS);
    await settle(fixture);
    await settle(fixture);
    const el = fixture.nativeElement as HTMLElement;
    expect(button(el, 'Novo cargo')).toBeUndefined();
    expect(button(el, 'Desactivar')).toBeUndefined();
  });

  it('distingue lista vazia de filtros sem resultados', async () => {
    configure({ listPositions: () => of([]) });
    const fixture = TestBed.createComponent(PositionsPanel);
    fixture.componentRef.setInput('units', UNITS);
    await settle(fixture);
    const el = fixture.nativeElement as HTMLElement;
    expect(el.textContent).toContain('Ainda não há cargos');
    (fixture.componentInstance as unknown as { query: { set(v: string): void } }).query.set('zzz');
    await settle(fixture);
    expect(el.textContent).toContain('Nenhum cargo corresponde aos filtros');
  });
});
