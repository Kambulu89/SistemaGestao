import { TestBed, type ComponentFixture } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import { firstValueFrom } from 'rxjs';
import { CustomFieldRegistryService } from '../../../core/dynamic/custom-field-registry.service';
import { DynamicEntityRegistryService } from '../../../core/dynamic/entity-registry.service';
import { TenantContextService } from '../../../core/tenant-context/tenant-context.service';
import { loginAs, setupMockBackend } from '../../../core/testing/test-backend';
import { CustomFieldsPage } from './custom-fields-page';

async function open(email: string, slug: string, entityKey = 'customer') {
  await loginAs(email);
  await firstValueFrom(TestBed.inject(TenantContextService).activate(slug));
  const registry = TestBed.inject(DynamicEntityRegistryService);
  await firstValueFrom(registry.ensureLoaded());
  const fixture = TestBed.createComponent(CustomFieldsPage);
  fixture.componentRef.setInput('entityKey', entityKey);
  await settle(fixture);
  return { fixture, el: fixture.nativeElement as HTMLElement, registry };
}

async function settle(fixture: ComponentFixture<unknown>) {
  fixture.detectChanges();
  await fixture.whenStable();
  await new Promise((resolve) => setTimeout(resolve, 5)); // respostas do mock (timer)
  fixture.detectChanges();
  fixture.detectChanges();
}

const button = (el: HTMLElement, text: string) =>
  [...el.querySelectorAll('button')].find((b) => b.textContent?.trim() === text);

function type(el: HTMLElement, label: string, value: string) {
  const lab = [...el.querySelectorAll('label')].find((l) =>
    l.textContent?.trim().startsWith(label),
  );
  const input = el.querySelector<HTMLInputElement | HTMLSelectElement>(`#${lab!.htmlFor}`)!;
  input.value = value;
  input.dispatchEvent(new Event(input instanceof HTMLSelectElement ? 'change' : 'input'));
  input.dispatchEvent(new Event('blur'));
}

describe('Campos personalizados: página e designer', () => {
  beforeEach(() => {
    setupMockBackend();
    TestBed.configureTestingModule({ providers: [provideRouter([])] });
  });

  it('lists native and custom fields with their state', async () => {
    const { el } = await open('escola@demo.pt', 'escola-horizonte');
    const rows = [...el.querySelectorAll('tbody tr')].map((r) =>
      r.textContent?.replace(/\s+/g, ' ').trim(),
    );
    expect(rows.find((r) => r?.startsWith('Nome'))).toContain('Nativo');
    expect(rows.find((r) => r?.includes('Sector de actividade'))).toContain('Activo');
    expect(rows.find((r) => r?.includes('Fax (antigo)'))).toContain('Arquivado');
    expect(rows.find((r) => r?.includes('NIF secundário'))).toContain('sensível');
    expect(el.textContent).not.toContain('Região comercial'); // campo de outro tenant
  });

  it('shows only the fields of the active tenant', async () => {
    const { el } = await open('frota@demo.pt', 'transportes-atlas');
    expect(el.textContent).toContain('Região comercial');
    expect(el.textContent).not.toContain('Sector de actividade');
  });

  it('says when the entity is not extensible', async () => {
    const { el } = await open('frota@demo.pt', 'transportes-atlas', 'note');
    expect(el.textContent).toContain('não aceita campos personalizados');
    expect(button(el, 'Novo campo')).toBeUndefined();
  });

  it('hides the create action from users without manage permission', async () => {
    const { el } = await open('multi@demo.pt', 'escola-horizonte'); // Secretário
    expect(button(el, 'Novo campo')).toBeUndefined();
    expect(button(el, 'Arquivar')).toBeUndefined();
  });

  it('creates a select field with options: the code follows the name and the form reflects it', async () => {
    const { fixture, el, registry } = await open('escola@demo.pt', 'escola-horizonte');
    button(el, 'Novo campo')!.click();
    await settle(fixture);

    type(el, 'Nome', 'Próximo contacto');
    await settle(fixture);
    const code = [...el.querySelectorAll<HTMLInputElement>('input')].find(
      (i) => i.value === 'proximoContacto',
    );
    expect(code).toBeDefined();

    type(el, 'Tipo de campo', 'select');
    await settle(fixture);
    expect(el.textContent).toContain('Opções');
    const optionInputs = el.querySelectorAll<HTMLInputElement>(
      '[data-testid=options-editor] input',
    );
    expect(optionInputs.length).toBeGreaterThanOrEqual(2);
    optionInputs[0]!.value = 'ana';
    optionInputs[0]!.dispatchEvent(new Event('input'));
    optionInputs[1]!.value = 'Ana';
    optionInputs[1]!.dispatchEvent(new Event('input'));
    await settle(fixture);
    // A pré-visualização usa o mesmo renderer dos formulários reais.
    expect(el.querySelector('app-dynamic-field select')).not.toBeNull();

    el.querySelector<HTMLButtonElement>('button[type=submit]')!.click();
    await settle(fixture);
    await settle(fixture);

    expect(registry.find('customer')!.fields.map((f) => f.key)).toContain('proximoContacto');
    expect(el.textContent).toContain('Campo guardado');
  });

  it('shows type-specific settings and flags advanced types as not yet available', async () => {
    const { fixture, el } = await open('escola@demo.pt', 'escola-horizonte');
    button(el, 'Novo campo')!.click();
    await settle(fixture);
    // Todos os tipos do catálogo estão disponíveis: não há aviso de «em preparação».
    expect(el.querySelector('[data-testid=preview-types]')).toBeNull();
    const types = [...el.querySelectorAll('select')[0]!.querySelectorAll('option')].map((o) =>
      o.textContent?.trim(),
    );
    expect(types).toEqual(
      expect.arrayContaining([
        'Fórmula',
        'Valor relacionado',
        'Numeração automática',
        'Referência a utilizador',
      ]),
    );

    type(el, 'Tipo de campo', 'currency');
    await settle(fixture);
    expect(el.textContent).toContain('Moeda (ISO 4217)');
    expect(el.textContent).toContain('Casas decimais');

    type(el, 'Tipo de campo', 'boolean');
    await settle(fixture);
    expect(el.textContent).not.toContain('Moeda (ISO 4217)');
    expect(el.textContent).not.toContain('Entra na pesquisa'); // booleano não é pesquisável
  });

  it('configures advanced types: formula, lookup, auto-number and user reference', async () => {
    const { fixture, el } = await open('frota@demo.pt', 'transportes-atlas');
    button(el, 'Novo campo')!.click();
    await settle(fixture);

    type(el, 'Tipo de campo', 'formula');
    await settle(fixture);
    expect(el.textContent).toContain('Expressão');
    expect(el.querySelector('[data-testid=formula-fields]')?.textContent).toContain(
      'nenhum campo numérico',
    );

    type(el, 'Tipo de campo', 'auto-number');
    await settle(fixture);
    expect(el.textContent).toContain('Prefixo');
    expect(el.textContent).toContain('Reinício da sequência');
    expect(el.textContent).not.toContain('Obrigatório'); // atribuído pelo servidor

    type(el, 'Tipo de campo', 'lookup');
    await settle(fixture);
    expect(el.textContent).toContain('Referência a seguir');
    expect(el.textContent).toContain('Campo a mostrar');
    expect(el.textContent).not.toContain('Entra na pesquisa');
  });

  it('creates a formula field through the designer and the server computes it', async () => {
    const { fixture, el, registry } = await open('frota@demo.pt', 'transportes-atlas');
    // Dois campos numéricos de base.
    for (const [name, kind] of [
      ['Quantidade', 'number'],
      ['Preço unitário', 'decimal'],
    ] as const) {
      button(el, 'Novo campo')!.click();
      await settle(fixture);
      type(el, 'Nome', name);
      type(el, 'Tipo de campo', kind);
      await settle(fixture);
      el.querySelector<HTMLButtonElement>('button[type=submit]')!.click();
      await settle(fixture);
    }
    button(el, 'Novo campo')!.click();
    await settle(fixture);
    type(el, 'Nome', 'Total estimado');
    type(el, 'Tipo de campo', 'formula');
    await settle(fixture);
    expect(el.querySelector('[data-testid=formula-fields]')?.textContent).toContain('quantidade');
    expect(el.querySelector('[data-testid=formula-fields]')?.textContent).toContain(
      'precoUnitario',
    );

    const expression = el.querySelector<HTMLTextAreaElement>('textarea[aria-required=true]')!;
    expression.value = 'quantidade * fantasma';
    expression.dispatchEvent(new Event('input'));
    await settle(fixture);
    expect(el.querySelector('[data-testid=designer-issues]')?.textContent).toContain(
      'campo desconhecido',
    );
    expect(el.querySelector<HTMLButtonElement>('button[type=submit]')!.disabled).toBe(true);

    expression.value = 'quantidade * precoUnitario';
    expression.dispatchEvent(new Event('input'));
    await settle(fixture);
    el.querySelector<HTMLButtonElement>('button[type=submit]')!.click();
    await settle(fixture);
    await settle(fixture);
    expect(registry.find('customer')!.fields.map((f) => f.key)).toContain('totalEstimado');
  });

  it('blocks saving a duplicate code and explains why', async () => {
    const { fixture, el } = await open('escola@demo.pt', 'escola-horizonte');
    button(el, 'Novo campo')!.click();
    await settle(fixture);
    type(el, 'Nome', 'Fax antigo'); // → faxAntigo, já usado por um campo arquivado
    await settle(fixture);
    expect(el.querySelector('[data-testid=designer-issues]')?.textContent).toContain('já existe');
    expect(el.querySelector<HTMLButtonElement>('button[type=submit]')!.disabled).toBe(true);
  });

  it('locks code and type of a published field', async () => {
    const { fixture, el } = await open('escola@demo.pt', 'escola-horizonte');
    const row = [...el.querySelectorAll('tbody tr')].find((r) =>
      r.textContent?.includes('Data de renovação'),
    )!;
    [...row.querySelectorAll('button')].find((b) => b.textContent?.trim() === 'Editar')!.click();
    await settle(fixture);
    expect(el.textContent).toContain('Campo publicado');
    const inputs = [...el.querySelectorAll<HTMLInputElement>('input[type=text]')];
    expect(inputs.find((i) => i.value === 'dataRenovacao')!.disabled).toBe(true);
    expect(el.querySelector<HTMLSelectElement>('select')!.disabled).toBe(true);
  });

  it('archives and reactivates a field from the list', async () => {
    const { fixture, el, registry } = await open('escola@demo.pt', 'escola-horizonte');
    const row = () =>
      [...el.querySelectorAll('tbody tr')].find((r) =>
        r.textContent?.includes('Data de renovação'),
      )!;
    [...row().querySelectorAll('button')]
      .find((b) => b.textContent?.trim() === 'Arquivar')!
      .click();
    await settle(fixture);
    await settle(fixture);
    expect(row().textContent).toContain('Arquivado');
    expect(registry.find('customer')!.fields.map((f) => f.key)).not.toContain('dataRenovacao');
    expect(
      TestBed.inject(CustomFieldRegistryService)
        .all()
        .some((c) => c.field.key === 'dataRenovacao'),
    ).toBe(true);
    [...row().querySelectorAll('button')]
      .find((b) => b.textContent?.trim() === 'Reactivar')!
      .click();
    await settle(fixture);
    await settle(fixture);
    expect(registry.find('customer')!.fields.map((f) => f.key)).toContain('dataRenovacao');
  });
});
