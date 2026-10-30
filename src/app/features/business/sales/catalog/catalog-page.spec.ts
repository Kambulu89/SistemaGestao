import { TestBed } from '@angular/core/testing';
import { of, throwError } from 'rxjs';
import { PermissionService } from '../../../../core/permissions/permission.service';
import { OrganizationApi } from '../../../tenant/data-access/organization.api';
import { SettingsApi } from '../../../tenant/data-access/settings.api';
import { CatalogApi, type PriceListDto, type ProductDto, type VariantDto } from './catalog.api';
import { CatalogPage } from './catalog-page';

const variant = (over: Partial<VariantDto> = {}): VariantDto => ({
  id: 'v1',
  productId: 'p1',
  sku: 'CAM-001',
  barcode: null,
  attributes: {},
  active: true,
  isDefault: true,
  version: 1,
  ...over,
});

const product = (over: Partial<ProductDto> = {}): ProductDto => ({
  id: 'p1',
  code: 'CAM-001',
  name: 'Camisola',
  description: null,
  type: 'GOODS',
  categoryId: null,
  baseUnitId: 'u1',
  trackStock: true,
  trackingMode: 'NONE',
  active: true,
  taxCategory: null,
  version: 1,
  ...over,
});

const priceList = (over: Partial<PriceListDto> = {}): PriceListDto => ({
  id: 'l1',
  organizationId: 'o1',
  name: 'Retalho',
  currency: 'AOA',
  validFrom: '2026-01-01',
  validTo: null,
  taxInclusive: false,
  priority: 0,
  version: 1,
  ...over,
});

async function render(api: Partial<CatalogApi> = {}, can: (p: string) => boolean = () => true) {
  TestBed.configureTestingModule({
    providers: [
      { provide: PermissionService, useValue: { can } },
      {
        provide: CatalogApi,
        useValue: {
          categories: () => of([]),
          products: () => of({ items: [product()], total: 1 }),
          product: () => of({ ...product(), variants: [variant()] }),
          priceLists: () => of([priceList()]),
          priceList: () => of({ ...priceList(), items: [] }),
          ...api,
        },
      },
      {
        provide: SettingsApi,
        useValue: {
          listUnits: () =>
            of([
              {
                id: 'u1',
                code: 'UN',
                name: 'Unidade',
                dimension: 'COUNT',
                precision: 0,
                baseUnitId: null,
                factor: null,
                version: 1,
              },
            ]),
        },
      },
      {
        provide: OrganizationApi,
        useValue: {
          listOrganizations: () =>
            of([
              {
                id: 'o1',
                code: 'EMP',
                legalName: 'Empresa, Lda.',
                tradeName: null,
                countryCode: 'AO',
                baseCurrency: 'AOA',
                active: true,
                version: 1,
              },
            ]),
        },
      },
    ],
  });
  const fixture = TestBed.createComponent(CatalogPage);
  const settle = async () => {
    fixture.detectChanges();
    await fixture.whenStable();
    fixture.detectChanges();
  };
  await settle();
  await settle();
  const el = fixture.nativeElement as HTMLElement;
  const button = (label: string) =>
    [...el.querySelectorAll('button')].find((b) => b.textContent?.trim() === label);
  const field = (label: string) => {
    const lab = [...el.querySelectorAll('label')].find((l) =>
      l.textContent?.trim().startsWith(label),
    );
    return el.querySelector<HTMLInputElement | HTMLSelectElement>(`#${lab?.htmlFor}`)!;
  };
  const type = async (label: string, value: string) => {
    const input = field(label);
    input.value = value;
    input.dispatchEvent(new Event(input instanceof HTMLSelectElement ? 'change' : 'input'));
    await settle();
  };
  const click = async (label: string) => {
    button(label)!.click();
    await settle();
    await settle();
  };
  const tab = async (id: string) => {
    el.querySelector<HTMLButtonElement>(`[data-testid=tab-${id}]`)!.click();
    await settle();
    await settle();
  };
  return { el, settle, button, field, type, click, tab };
}

const text = (el: Element | null | undefined) => el?.textContent?.replace(/\s+/g, ' ').trim();

describe('Catálogo', () => {
  it('lista os produtos e só mostra as abas a que a permissão dá acesso', async () => {
    const { el } = await render({}, (p) => p === 'catalog.read');
    expect(text(el.querySelector('[data-testid=products] tbody tr'))).toContain('Camisola');
    expect(el.querySelector('[data-testid=tab-prices]')).toBeNull();
    expect([...el.querySelectorAll('button')].some((b) => text(b) === 'Novo produto')).toBe(false);
  });

  it('cria um produto com a variante por omissão e mostra-a', async () => {
    const createProduct = vi.fn(() =>
      of({
        ...product({ id: 'p2', code: 'NOVO', name: 'Novo' }),
        variants: [variant({ sku: 'NOVO' })],
      }),
    );
    const { el, click, type } = await render({ createProduct });
    await click('Novo produto');
    await type('Código', 'NOVO');
    await type('Nome', 'Novo');
    await type('Unidade de base', 'u1');
    await click('Guardar');
    expect(createProduct).toHaveBeenCalledWith(
      expect.objectContaining({
        code: 'NOVO',
        name: 'Novo',
        type: 'GOODS',
        baseUnitId: 'u1',
        trackStock: true,
      }),
    );
    expect(text(el.querySelector('[data-testid=variants] tbody tr'))).toContain('Por omissão');
  });

  it('um serviço não oferece controlo de stock e é enviado sem stock nem rastreio', async () => {
    const createProduct = vi.fn(() =>
      of({ ...product({ id: 'p3', type: 'SERVICE' }), variants: [] }),
    );
    const { el, click, type } = await render({ createProduct });
    await click('Novo produto');
    await type('Código', 'SRV');
    await type('Nome', 'Montagem');
    await type('Unidade de base', 'u1');
    await type('Tipo', 'SERVICE');
    expect(el.textContent).not.toContain('Controlar stock');
    await click('Guardar');
    expect(createProduct).toHaveBeenCalledOnce();
    expect(createProduct).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'SERVICE', trackStock: false, trackingMode: 'NONE' }),
    );
  });

  it('mostra a mensagem própria do catálogo quando o SKU já existe', async () => {
    const createVariant = vi.fn(() =>
      throwError(() => ({ status: 409, code: 'SKU_TAKEN', message: 'x' })),
    );
    const { el, click, type } = await render({ createVariant });
    await click('Editar');
    await type('SKU', 'CAM-001');
    await click('Acrescentar variante');
    expect(createVariant).toHaveBeenCalled();
    expect(el.textContent).toContain('Já existe uma variante com este SKU.');
  });

  it('nas tabelas de preços recusa preços com mais de 4 casas e resolve o preço com a origem', async () => {
    const addPriceItem = vi.fn();
    const resolvePrice = vi.fn(() =>
      of({
        variantId: 'v1',
        sku: 'CAM-001',
        quantity: '10',
        date: '2026-10-24',
        currency: 'AOA',
        priceListId: 'l1',
        priceListName: 'Retalho',
        priority: 0,
        taxInclusive: false,
        minQuantity: '10.000000',
        unitPrice: '1350.0000',
        maxDiscount: '0.0500',
      }),
    );
    const products = vi.fn(() => of({ items: [product()], total: 1 }));
    const { el, click, type, tab } = await render({ addPriceItem, resolvePrice, products });
    await tab('prices');
    await click('Abrir');
    await type('SKU da variante', 'CAM-001');
    await type('Preço unitário', '1500.12345');
    await click('Acrescentar preço');
    expect(addPriceItem).not.toHaveBeenCalled();
    expect(el.textContent).toContain('até 4 casas decimais');
    await click('Fechar');
    await type('Organização', 'o1');
    await type('SKU da variante', 'CAM-001');
    await type('Moeda', 'aoa');
    await type('Quantidade', '10');
    await click('Resolver preço');
    expect(resolvePrice).toHaveBeenCalledWith(
      expect.objectContaining({
        variantId: 'v1',
        organizationId: 'o1',
        currency: 'AOA',
        quantity: '10',
      }),
    );
    expect(text(el.querySelector('[data-testid=resolved]'))).toContain('Retalho');
    expect(text(el.querySelector('[data-testid=resolved]'))).toContain('1 350,0000 AOA');
  });
});
