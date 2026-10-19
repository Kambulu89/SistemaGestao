import { type ComponentFixture, TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import { firstValueFrom } from 'rxjs';
import { DynamicEntityRegistryService } from '../../../core/dynamic/entity-registry.service';
import { TenantContextService } from '../../../core/tenant-context/tenant-context.service';
import { loginAs, setupMockBackend } from '../../../core/testing/test-backend';
import { RecordFormPage } from '../dynamic-records/record-form-page';
import { RecordsListPage } from '../dynamic-records/records-list-page';
import { EntityDesignerPage } from './entity-designer-page';

async function open(email: string, slug: string, inputs: Record<string, unknown> = {}) {
  await loginAs(email);
  await firstValueFrom(TestBed.inject(TenantContextService).activate(slug));
  const registry = TestBed.inject(DynamicEntityRegistryService);
  await firstValueFrom(registry.ensureLoaded());
  return mount(EntityDesignerPage, inputs, registry);
}

function mount(
  component: new () => unknown,
  inputs: Record<string, unknown>,
  registry: DynamicEntityRegistryService,
) {
  const fixture: ComponentFixture<unknown> = TestBed.createComponent(component);
  for (const [key, value] of Object.entries(inputs)) fixture.componentRef.setInput(key, value);
  const el = fixture.nativeElement as HTMLElement;
  const until = (done: () => boolean) =>
    vi.waitFor(
      () => {
        fixture.detectChanges();
        expect(done(), el.textContent ?? '').toBe(true);
      },
      { timeout: 3000 },
    );
  fixture.detectChanges();
  return { fixture, el, until, registry };
}

const button = (el: HTMLElement, text: string) =>
  [...el.querySelectorAll('button')].find((b) => b.textContent?.trim() === text);
const field = (el: HTMLElement, label: string) => {
  const lab = [...el.querySelectorAll('label')].find((l) =>
    l.textContent?.trim().startsWith(label),
  );
  return el.querySelector<HTMLInputElement | HTMLSelectElement>(`#${lab?.htmlFor}`)!;
};
function type(el: HTMLElement, label: string, value: string) {
  const input = field(el, label);
  input.value = value;
  input.dispatchEvent(new Event(input instanceof HTMLSelectElement ? 'change' : 'input'));
  input.dispatchEvent(new Event('blur'));
}
const listed = (el: HTMLElement) =>
  [...el.querySelectorAll('[data-testid=field-list] li')].map((li) =>
    li.querySelector('span')?.textContent?.trim(),
  );

/** Acrescenta um campo através do designer (a UI real). */
async function addField(
  m: ReturnType<typeof mount>,
  spec: { name: string; type?: string; required?: boolean; extra?: () => void },
) {
  button(m.el, 'Adicionar campo')!.click();
  await m.until(() => !!button(m.el, 'Aplicar campo'));
  type(m.el, 'Nome', spec.name);
  if (spec.type) type(m.el, 'Tipo de campo', spec.type);
  m.fixture.detectChanges();
  spec.extra?.();
  m.fixture.detectChanges();
  await m.until(() => !(button(m.el, 'Aplicar campo') as HTMLButtonElement).disabled);
  button(m.el, 'Aplicar campo')!.click();
  await m.until(() => !!m.el.querySelector('[data-testid=field-list]'));
}

describe('Designer de entidades (caso D: Equipamento só por metadados)', () => {
  beforeEach(() => {
    setupMockBackend();
    TestBed.configureTestingModule({ providers: [provideRouter([])] });
  });

  async function buildEquipamento() {
    const m = await open('frota@demo.pt', 'transportes-atlas');
    type(m.el, 'Nome (singular)', 'Equipamento');
    type(m.el, 'Nome (plural)', 'Equipamentos');
    m.fixture.detectChanges();
    expect(field(m.el, 'Código').value).toBe('equipamento');

    await addField(m, { name: 'Código interno' });
    await addField(m, { name: 'Designação' });
    await addField(m, { name: 'Data de aquisição', type: 'date' });
    await addField(m, {
      name: 'Valor',
      type: 'currency',
      extra: () => type(m.el, 'Moeda', 'EUR'),
    });
    await addField(m, { name: 'Responsável' });
    await addField(m, {
      name: 'Estado',
      type: 'select',
      extra: () => {
        const inputs = m.el.querySelectorAll<HTMLInputElement>(
          '[data-testid=options-editor] input',
        );
        const set = (i: number, v: string) => {
          inputs[i]!.value = v;
          inputs[i]!.dispatchEvent(new Event('input'));
        };
        set(0, 'activo');
        set(1, 'Activo');
      },
    });
    return m;
  }

  it('builds the whole entity through the UI and previews the generated form', async () => {
    const m = await buildEquipamento();
    expect(listed(m.el)).toEqual([
      'Código interno',
      'Designação',
      'Data de aquisição',
      'Valor',
      'Responsável',
      'Estado',
    ]);
    // Pré-visualização gerada pelo mesmo renderer dos formulários reais.
    const preview = [...m.el.querySelectorAll('app-dynamic-form label')].map((l) =>
      l.textContent?.replace('*', '').trim(),
    );
    expect(preview).toEqual(
      expect.arrayContaining(['Código interno', 'Designação', 'Data de aquisição', 'Valor']),
    );
  });

  it('publishes: the entity then has working list and form pages with no specific component', async () => {
    const m = await buildEquipamento();
    button(m.el, 'Publicar')!.click();
    await m.until(() => m.el.textContent!.includes('Entidade publicada'));
    expect(m.registry.find('equipamento')).toMatchObject({ version: 1, state: 'published' });

    const form = mount(RecordFormPage, { entityKey: 'equipamento' }, m.registry);
    await form.until(() => !!form.el.querySelector('form'));
    expect(form.el.textContent).toContain('Código interno');
    expect(form.el.textContent).toContain('Valor');

    const list = mount(RecordsListPage, { entityKey: 'equipamento' }, m.registry);
    await list.until(() => list.el.querySelector('h1')?.textContent === 'Equipamentos');
  });

  it('keeps unpublished work as a draft that users cannot reach', async () => {
    const m = await buildEquipamento();
    button(m.el, 'Guardar rascunho')!.click();
    await m.until(() => m.el.textContent!.includes('Rascunho guardado'));
    expect(m.registry.draftOf('equipamento')).toBeDefined();
    expect(m.registry.find('equipamento')).toBeUndefined();
  });

  it('reorders and removes fields before publishing', async () => {
    const m = await open('frota@demo.pt', 'transportes-atlas');
    type(m.el, 'Nome (singular)', 'Item');
    type(m.el, 'Nome (plural)', 'Itens');
    await addField(m, { name: 'Alfa' });
    await addField(m, { name: 'Beta' });
    await addField(m, { name: 'Gama' });
    const rowButton = (row: number) =>
      [...m.el.querySelectorAll('[data-testid=field-list] li')][row]!.querySelectorAll('button');
    [...rowButton(2)].find((b) => b.textContent?.trim() === 'Subir')!.click();
    m.fixture.detectChanges();
    expect(listed(m.el)).toEqual(['Alfa', 'Gama', 'Beta']);
    [...rowButton(0)].find((b) => b.textContent?.trim() === 'Remover')!.click();
    m.fixture.detectChanges();
    expect(listed(m.el)).toEqual(['Gama', 'Beta']);
  });

  it('blocks publishing with a clear message while the entity is incomplete', async () => {
    const m = await open('frota@demo.pt', 'transportes-atlas');
    expect((button(m.el, 'Publicar') as HTMLButtonElement).disabled).toBe(true);
    expect(m.el.querySelector('[data-testid=entity-issues]')?.textContent).toContain(
      'pelo menos um campo',
    );
  });

  it('rejects a duplicate field code inside the entity', async () => {
    const m = await open('frota@demo.pt', 'transportes-atlas');
    type(m.el, 'Nome (singular)', 'Item');
    type(m.el, 'Nome (plural)', 'Itens');
    await addField(m, { name: 'Alfa' });
    button(m.el, 'Adicionar campo')!.click();
    await m.until(() => !!button(m.el, 'Aplicar campo'));
    type(m.el, 'Nome', 'Alfa');
    await m.until(() => !!m.el.querySelector('[data-testid=designer-issues]'));
    expect(m.el.querySelector('[data-testid=designer-issues]')!.textContent).toContain('já existe');
  });

  it('edits a published tenant entity as a new draft: published identity is locked', async () => {
    const m = await open('frota@demo.pt', 'transportes-atlas', { entityKey: 'vehicle' });
    await m.until(() => !!m.el.querySelector('[data-testid=field-list]'));
    expect(field(m.el, 'Código').disabled).toBe(true);
    // O campo publicado arquiva-se em vez de se remover.
    const first = m.el.querySelector('[data-testid=field-list] li')!;
    expect([...first.querySelectorAll('button')].map((b) => b.textContent?.trim())).toContain(
      'Arquivar',
    );
    expect([...first.querySelectorAll('button')].map((b) => b.textContent?.trim())).not.toContain(
      'Remover',
    );

    [...first.querySelectorAll('button')].find((b) => b.textContent?.trim() === 'Editar')!.click();
    await m.until(() => !!button(m.el, 'Aplicar campo'));
    expect(field(m.el, 'Código').disabled).toBe(true);
    expect(field(m.el, 'Tipo de campo').disabled).toBe(true);
  });

  it('refuses to edit a platform entity and explains how to extend it', async () => {
    const m = await open('escola@demo.pt', 'escola-horizonte', { entityKey: 'customer' });
    await m.until(() => m.el.textContent!.includes('Não é possível editar esta entidade'));
    expect(m.el.textContent).toContain('campos personalizados');
  });

  it('does not allow publishing without the manage permission', async () => {
    const m = await open('operador@demo.pt', 'transportes-atlas');
    expect(button(m.el, 'Publicar')).toBeUndefined();
    expect(m.el.textContent).toContain('Não tem permissão para gerir entidades');
  });
});
