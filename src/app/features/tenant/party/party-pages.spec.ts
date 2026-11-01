import { TestBed } from '@angular/core/testing';
import { of, throwError } from 'rxjs';
import { describe, expect, it, vi } from 'vitest';
import { PermissionService } from '../../../core/permissions/permission.service';
import { TenantContextService } from '../../../core/tenant-context/tenant-context.service';
import { PartiesPage } from './parties-page';
import { PartyDetail } from './party-detail';
import { PartyApi, type PartyDetailDto, type PartyDto } from './party.api';

const PARTY: PartyDto = {
  id: 'p1',
  kind: 'PERSON',
  displayName: 'Ana Silva',
  status: 'ACTIVE',
  externalReference: null,
  version: 4,
};

const detail = (over: Partial<PartyDetailDto> = {}): PartyDetailDto => ({
  ...PARTY,
  person: {
    id: 'pp',
    givenNames: 'Ana',
    familyName: 'Silva',
    birthDate: null,
    nationality: 'PT',
  },
  organization: null,
  contacts: [
    {
      id: 'c1',
      partyId: 'p1',
      type: 'EMAIL',
      value: 'ana@x.invalid',
      label: null,
      isPrimary: true,
      version: 1,
    },
  ],
  addresses: [],
  possibleDuplicates: [],
  ...over,
});

function configure(
  api: Record<string, unknown>,
  granted = ['party.read', 'party.create', 'party.update'],
) {
  TestBed.configureTestingModule({
    providers: [
      { provide: PermissionService, useValue: { can: (p: string) => granted.includes(p) } },
      { provide: TenantContextService, useValue: { tenant: () => ({ id: 't1' }) } },
      {
        provide: PartyApi,
        useValue: {
          list: vi.fn(() => of([PARTY])),
          get: vi.fn(() => of(detail())),
          relationships: () => of([]),
          ...api,
        },
      },
    ],
  });
}

async function settle(fixture: { detectChanges(): void; whenStable(): Promise<unknown> }) {
  for (let i = 0; i < 3; i++) {
    fixture.detectChanges();
    await fixture.whenStable();
  }
  fixture.detectChanges();
}
const field = (el: HTMLElement, label: string) => {
  const lab = [...el.querySelectorAll('label')].find((l) =>
    l.textContent?.trim().startsWith(label),
  );
  return el.querySelector<HTMLInputElement | HTMLSelectElement>(`#${lab?.htmlFor}`)!;
};
const type = (el: HTMLElement, label: string, value: string) => {
  const input = field(el, label);
  input.value = value;
  input.dispatchEvent(new Event(input instanceof HTMLSelectElement ? 'change' : 'input'));
};
const button = (root: ParentNode, label: string) =>
  [...root.querySelectorAll('button')].find((b) => b.textContent?.trim() === label)!;

describe('PartiesPage', () => {
  it('lista fichas e só pesquisa com 2 ou mais letras', async () => {
    const list = vi.fn(() => of([PARTY]));
    configure({ list });
    const fixture = TestBed.createComponent(PartiesPage);
    await settle(fixture);
    const el = fixture.nativeElement as HTMLElement;
    expect(el.textContent).toContain('Ana Silva');
    type(el, 'Pesquisar', 'a');
    await settle(fixture);
    expect(el.textContent).toContain('2 ou mais letras');
    expect(list).toHaveBeenLastCalledWith({ limit: 25, offset: 0 });
    type(el, 'Pesquisar', 'an');
    await settle(fixture);
    expect(list).toHaveBeenLastCalledWith({ limit: 25, offset: 0, q: 'an' });
  });

  it('exige nome e apelido antes de criar uma pessoa e abre a ficha criada', async () => {
    const createPerson = vi.fn(() => of(detail()));
    configure({ createPerson });
    const fixture = TestBed.createComponent(PartiesPage);
    await settle(fixture);
    const el = fixture.nativeElement as HTMLElement;
    button(el, 'Nova pessoa').click();
    await settle(fixture);
    button(document.body, 'Criar').click();
    await settle(fixture);
    expect(createPerson).not.toHaveBeenCalled();
    expect(document.body.textContent).toContain('Indique os nomes próprios');
    type(document.body, 'Nomes próprios', 'Ana');
    type(document.body, 'Apelido', 'Silva');
    await settle(fixture);
    button(document.body, 'Criar').click();
    await settle(fixture);
    expect(createPerson).toHaveBeenCalledWith({
      displayName: null,
      externalReference: null,
      givenNames: 'Ana',
      familyName: 'Silva',
    });
    expect(el.querySelector('[data-testid=party-name]')?.textContent).toContain('Ana Silva');
  });

  it('esconde as acções de criar sem party.create', async () => {
    configure({}, ['party.read']);
    const fixture = TestBed.createComponent(PartiesPage);
    await settle(fixture);
    const el = fixture.nativeElement as HTMLElement;
    expect([...el.querySelectorAll('button')].some((b) => b.textContent?.includes('Nova'))).toBe(
      false,
    );
  });
});

describe('PartyDetail', () => {
  async function open(api: Record<string, unknown> = {}, granted?: string[]) {
    configure(api, granted);
    const fixture = TestBed.createComponent(PartyDetail);
    fixture.componentRef.setInput('partyId', 'p1');
    await settle(fixture);
    return { fixture, el: fixture.nativeElement as HTMLElement };
  }

  it('só mostra e envia os campos sensíveis que o servidor devolveu', async () => {
    const update = vi.fn(() => of(detail()));
    const { fixture, el } = await open({ update });
    expect(field(el, 'Nacionalidade')).toBeTruthy();
    expect(field(el, 'Número de identificação')).toBeNull();
    expect(el.querySelector('[data-testid=hidden-note]')).not.toBeNull();
    button(el, 'Guardar').click();
    await settle(fixture);
    const [, changes] = update.mock.calls[0] as unknown as [
      PartyDto,
      { person: Record<string, unknown> },
    ];
    expect(Object.keys(changes.person).sort()).toEqual([
      'birthDate',
      'familyName',
      'givenNames',
      'nationality',
    ]);
  });

  it('avisa quando há dados pessoais ocultos', async () => {
    const hidden = detail({
      person: { id: 'pp', givenNames: 'Ana', familyName: 'Silva' },
    });
    const { el } = await open({ get: () => of(hidden) });
    expect(el.querySelector('[data-testid=hidden-note]')).not.toBeNull();
    expect(field(el, 'Nacionalidade')).toBeNull();
  });

  it('mostra os possíveis duplicados com o motivo', async () => {
    const dup = detail({
      possibleDuplicates: [
        { partyId: 'p2', displayName: 'Ana S.', reasons: ['TAX_ID', 'CONTACT'] },
      ],
    });
    const { el } = await open({ get: () => of(dup) });
    expect(el.querySelector('[data-testid=duplicates]')?.textContent).toContain(
      'mesmo NIF, mesmo contacto',
    );
  });

  it('valida o contacto e a morada antes de enviar', async () => {
    const addContact = vi.fn(() => of({}));
    const addAddress = vi.fn(() => of({}));
    const { fixture, el } = await open({ addContact, addAddress });
    button(el, 'Adicionar contacto').click();
    await settle(fixture);
    expect(addContact).not.toHaveBeenCalled();
    expect(el.textContent).toContain('Indique o valor do contacto');
    button(el, 'Adicionar morada').click();
    await settle(fixture);
    expect(addAddress).not.toHaveBeenCalled();
    expect(el.textContent).toContain('Indique a morada e a localidade');
  });

  it('adiciona contacto e remove outro', async () => {
    const addContact = vi.fn(() => of({}));
    const removeContact = vi.fn(() => of(undefined));
    const { fixture, el } = await open({ addContact, removeContact });
    type(el, 'Valor', '+351 912 345 678');
    await settle(fixture);
    button(el, 'Adicionar contacto').click();
    expect(addContact).toHaveBeenCalledWith('p1', {
      type: 'EMAIL',
      value: '+351 912 345 678',
      label: null,
      isPrimary: false,
    });
    button(el, 'Remover').click();
    expect(removeContact).toHaveBeenCalledWith('c1');
  });

  it('explica o conflito de versão e recarrega', async () => {
    const get = vi.fn(() => of(detail()));
    const update = vi.fn(() => throwError(() => ({ code: 'VERSION_CONFLICT', message: 'x' })));
    const { fixture, el } = await open({ get, update });
    button(el, 'Guardar').click();
    await settle(fixture);
    expect(el.textContent).toContain('alterada entretanto');
    expect(get.mock.calls.length).toBeGreaterThan(1);
  });

  it('sem party.update é só de leitura', async () => {
    const { el } = await open({}, ['party.read']);
    expect(el.querySelector('[data-testid=contact-form]')).toBeNull();
    expect([...el.querySelectorAll('button')].map((b) => b.textContent?.trim())).toEqual([
      '← Voltar à lista',
    ]);
    expect(field(el, 'Nome a apresentar').disabled).toBe(true);
  });
});
