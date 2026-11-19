/** Catálogo do inventário (8.1): tipos, rótulos e preparação de dados para a API (texto decimal, nunca `float`). */

export type ProductType = 'STOCKABLE' | 'SERVICE' | 'KIT';
export type ProductStatus = 'ACTIVE' | 'INACTIVE' | 'DISCONTINUED';

export interface Uom {
  id: string;
  version: number;
  code: string;
  name: string;
  category: string;
  decimals: number;
  status: 'ACTIVE' | 'INACTIVE';
}
export interface Category {
  id: string;
  version: number;
  code: string;
  name: string;
  parentId: string | null;
  accountingClass: string | null;
  status: 'ACTIVE' | 'INACTIVE';
}
export interface Brand {
  id: string;
  version: number;
  code: string;
  name: string;
  status: 'ACTIVE' | 'INACTIVE';
}
export interface Variant {
  id: string;
  version: number;
  productId: string;
  sku: string;
  barcode: string | null;
  attributes: Record<string, string>;
  salePrice: string | null;
  status: ProductStatus;
}
export interface Product {
  id: string;
  version: number;
  sku: string;
  barcode: string | null;
  name: string;
  description: string | null;
  productType: ProductType;
  status: ProductStatus;
  category: { id: string; code: string; name: string } | null;
  brand: { id: string; name: string } | null;
  baseUom: { id: string; code: string; decimals: number };
  purchaseUom: { id: string; code: string } | null;
  saleUom: { id: string; code: string } | null;
  trackLots: boolean;
  trackSerials: boolean;
  trackExpiry: boolean;
  /** Valorização (8.9): custo médio, FIFO ou custo específico (por lote). */
  valuationMethod?: 'AVERAGE' | 'FIFO' | 'SPECIFIC';
  shelfLifeDays: number | null;
  minStock: string | null;
  maxStock: string | null;
  currency: string | null;
  salePrice: string | null;
  accountingClass: string | null;
  hasVariants: boolean;
  effectiveAccountingClass?: string | null;
  accountingClassSource?: 'PRODUCT' | 'CATEGORY';
  conversions?: { id: string; uomId: string; uomCode: string; uomName: string; factor: string }[];
  components?: {
    id: string;
    componentId: string;
    sku: string;
    name: string;
    uomCode: string;
    quantity: string;
  }[];
  variants?: Variant[];
}

export const PRODUCT_TYPE: Record<ProductType, string> = {
  STOCKABLE: 'Armazenável',
  SERVICE: 'Serviço',
  KIT: 'Kit',
};
export const PRODUCT_STATUS: Record<ProductStatus, string> = {
  ACTIVE: 'Activo',
  INACTIVE: 'Inactivo',
  DISCONTINUED: 'Descontinuado',
};
export const UOM_CATEGORY: Record<string, string> = {
  UNIT: 'Unidade',
  WEIGHT: 'Peso',
  VOLUME: 'Volume',
  LENGTH: 'Comprimento',
  AREA: 'Área',
  TIME: 'Tempo',
  OTHER: 'Outra',
};

export function productTone(s: ProductStatus): string {
  if (s === 'ACTIVE') return 'bg-success-soft text-success-text';
  if (s === 'DISCONTINUED') return 'bg-warning-soft text-warning-text';
  return 'bg-surface-2 text-muted';
}

/** Dígito de controlo GTIN (aviso imediato; o servidor volta a validar). */
export function gtinValid(code: string): boolean {
  if (!/^\d+$/.test(code) || ![8, 12, 13, 14].includes(code.length)) return true;
  let sum = 0;
  const body = code.slice(0, -1);
  for (let i = 0; i < body.length; i++) {
    const d = Number(body[body.length - 1 - i]);
    sum += i % 2 === 0 ? d * 3 : d;
  }
  return (10 - (sum % 10)) % 10 === Number(code.at(-1));
}

/** "1 CX = 24 UN" */
export function conversionLabel(uomCode: string, factor: string, baseCode: string): string {
  return `1 ${uomCode} = ${factor.replace('.', ',')} ${baseCode}`;
}

/** Texto decimal com vírgula ou ponto → canónico com ponto; vazio → null. */
export function decimalText(v: string | null | undefined): string | null {
  const t = (v ?? '').trim().replace(/\s/g, '').replace(',', '.');
  return t === '' ? null : t;
}

/** Categorias com o caminho completo ("Mercadorias › Bebidas"), por ordem do caminho. */
export function categoryPaths(list: Category[]): { id: string; label: string }[] {
  const byId = new Map(list.map((c) => [c.id, c]));
  const path = (c: Category, seen = new Set<string>()): string => {
    const parent = c.parentId ? byId.get(c.parentId) : undefined;
    if (!parent || seen.has(parent.id)) return c.name;
    seen.add(c.id);
    return `${path(parent, seen)} › ${c.name}`;
  };
  return list
    .map((c) => ({ id: c.id, label: path(c) }))
    .sort((a, b) => a.label.localeCompare(b.label, 'pt'));
}

export interface ProductForm {
  sku: string;
  barcode: string;
  name: string;
  description: string;
  productType: ProductType;
  status: ProductStatus;
  categoryId: string;
  brandId: string;
  baseUomId: string;
  purchaseUomId: string;
  saleUomId: string;
  trackLots: boolean;
  trackSerials: boolean;
  trackExpiry: boolean;
  valuationMethod: string;
  shelfLifeDays: string;
  minStock: string;
  maxStock: string;
  salePrice: string;
  currency: string;
  accountingClass: string;
  conversions: { uomId: string; factor: string }[];
  components: { componentId: string; quantity: string }[];
}

export function emptyProductForm(currency = 'AOA'): ProductForm {
  return {
    sku: '',
    barcode: '',
    name: '',
    description: '',
    productType: 'STOCKABLE',
    status: 'ACTIVE',
    categoryId: '',
    brandId: '',
    baseUomId: '',
    purchaseUomId: '',
    saleUomId: '',
    trackLots: false,
    trackSerials: false,
    trackExpiry: false,
    valuationMethod: 'AVERAGE',
    shelfLifeDays: '',
    minStock: '',
    maxStock: '',
    salePrice: '',
    currency,
    accountingClass: '',
    conversions: [],
    components: [],
  };
}

export function formFromProduct(p: Product): ProductForm {
  return {
    sku: p.sku,
    barcode: p.barcode ?? '',
    name: p.name,
    description: p.description ?? '',
    productType: p.productType,
    status: p.status,
    categoryId: p.category?.id ?? '',
    brandId: p.brand?.id ?? '',
    baseUomId: p.baseUom.id,
    purchaseUomId: p.purchaseUom?.id ?? '',
    saleUomId: p.saleUom?.id ?? '',
    trackLots: p.trackLots,
    trackSerials: p.trackSerials,
    trackExpiry: p.trackExpiry,
    valuationMethod: p.valuationMethod ?? 'AVERAGE',
    shelfLifeDays: p.shelfLifeDays === null ? '' : String(p.shelfLifeDays),
    minStock: p.minStock ?? '',
    maxStock: p.maxStock ?? '',
    salePrice: p.salePrice ?? '',
    currency: p.currency ?? 'AOA',
    accountingClass: p.accountingClass ?? '',
    conversions: (p.conversions ?? []).map((c) => ({ uomId: c.uomId, factor: c.factor })),
    components: (p.components ?? []).map((c) => ({
      componentId: c.componentId,
      quantity: c.quantity,
    })),
  };
}

/**
 * Corpo para a API. Serviços e kits não levam dados de stock (o servidor recusa-os); só os kits levam componentes.
 */
export function productPayload(f: ProductForm): Record<string, unknown> {
  const stock = f.productType === 'STOCKABLE';
  const days = f.shelfLifeDays.trim();
  const price = decimalText(f.salePrice);
  return {
    sku: f.sku.trim(),
    barcode: f.barcode.trim() || null,
    name: f.name.trim(),
    description: f.description.trim() || null,
    productType: f.productType,
    status: f.status,
    categoryId: f.categoryId || null,
    brandId: f.brandId || null,
    baseUomId: f.baseUomId || null,
    purchaseUomId: f.purchaseUomId || null,
    saleUomId: f.saleUomId || null,
    trackLots: stock && f.trackLots,
    trackSerials: stock && f.trackSerials,
    trackExpiry: stock && f.trackExpiry,
    ...(stock ? { valuationMethod: f.valuationMethod } : {}),
    shelfLifeDays:
      stock && f.trackExpiry && days ? (/^\d+$/.test(days) ? Number(days) : days) : null,
    minStock: stock ? decimalText(f.minStock) : null,
    maxStock: stock ? decimalText(f.maxStock) : null,
    salePrice: price,
    currency: price ? f.currency.trim().toUpperCase() : null,
    accountingClass: f.accountingClass.trim().toUpperCase() || null,
    conversions: f.conversions
      .filter((c) => c.uomId || c.factor)
      .map((c) => ({ uomId: c.uomId, factor: decimalText(c.factor) })),
    components:
      f.productType === 'KIT'
        ? f.components
            .filter((c) => c.componentId || c.quantity)
            .map((c) => ({ componentId: c.componentId, quantity: decimalText(c.quantity) }))
        : [],
  };
}

/** Atributos "Cor=Azul; Tamanho=M" ⇄ objecto. */
export function parseAttributes(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const part of text.split(/[;\n]/)) {
    const [k, ...rest] = part.split('=');
    const key = k?.trim();
    const value = rest.join('=').trim();
    if (key && value) out[key] = value;
  }
  return out;
}

export function attributesText(a: Record<string, string>): string {
  return Object.entries(a)
    .map(([k, v]) => `${k}=${v}`)
    .join('; ');
}

/** Preço com 4 casas guardadas → mostrado com 2 a 4 casas ("150.5000" → "150,50"; "1.2345" → "1,2345"). */
export function priceLabel(v: string | null, currency?: string | null): string {
  if (v === null) return '—';
  const [int, frac = ''] = v.split('.');
  const shown = frac.replace(/0+$/, '').padEnd(2, '0');
  const grouped = int.replace(/\B(?=(\d{3})+(?!\d))/g, ' ');
  return `${grouped},${shown}${currency ? ` ${currency}` : ''}`;
}
