import { inject, Injectable } from '@angular/core';
import { map, type Observable } from 'rxjs';
import { ApiService } from '../../../../core/api/api.service';

export type ProductType = 'GOODS' | 'SERVICE';
export type TrackingMode = 'NONE' | 'LOT' | 'SERIAL';
export type Attributes = Readonly<Record<string, string | number | boolean>>;

export interface CategoryDto {
  readonly id: string;
  readonly code: string;
  readonly name: string;
  readonly parentId: string | null;
  readonly version: number;
}

export interface VariantDto {
  readonly id: string;
  readonly productId: string;
  readonly sku: string;
  readonly barcode: string | null;
  readonly attributes: Attributes;
  readonly active: boolean;
  readonly isDefault: boolean;
  readonly version: number;
}

export interface ProductDto {
  readonly id: string;
  readonly code: string;
  readonly name: string;
  readonly description: string | null;
  readonly type: ProductType;
  readonly categoryId: string | null;
  readonly baseUnitId: string;
  readonly trackStock: boolean;
  readonly trackingMode: TrackingMode;
  readonly active: boolean;
  readonly taxCategory: string | null;
  readonly version: number;
  readonly variants?: readonly VariantDto[];
}

export interface ProductBody {
  readonly code?: string;
  readonly name: string;
  readonly description?: string | null;
  readonly type: ProductType;
  readonly categoryId?: string | null;
  readonly baseUnitId: string;
  readonly trackStock: boolean;
  readonly trackingMode: TrackingMode;
  readonly active?: boolean;
  readonly sku?: string;
  readonly barcode?: string | null;
}

export interface ProductFilter {
  readonly q?: string;
  readonly type?: ProductType;
  readonly categoryId?: string;
  readonly active?: boolean;
  readonly limit?: number;
  readonly offset?: number;
}

export interface ProductPage {
  readonly items: readonly ProductDto[];
  readonly total: number;
}

export interface PriceListDto {
  readonly id: string;
  readonly organizationId: string;
  readonly name: string;
  readonly currency: string;
  readonly validFrom: string;
  readonly validTo: string | null;
  readonly taxInclusive: boolean;
  readonly priority: number;
  readonly version: number;
  readonly items?: readonly PriceItemDto[];
}

export interface PriceListBody {
  readonly organizationId?: string;
  readonly name: string;
  readonly currency?: string;
  readonly validFrom: string;
  readonly validTo: string | null;
  readonly taxInclusive: boolean;
  readonly priority: number;
}

export interface PriceItemDto {
  readonly id: string;
  readonly priceListId: string;
  readonly variantId: string;
  readonly sku: string;
  /** Decimais como texto: nunca `number`. */
  readonly minQuantity: string;
  readonly unitPrice: string;
  readonly maxDiscount: string;
  readonly version: number;
}

export interface ResolvedPriceDto {
  readonly variantId: string;
  readonly sku: string;
  readonly quantity: string;
  readonly date: string;
  readonly currency: string;
  readonly priceListId: string;
  readonly priceListName: string;
  readonly priority: number;
  readonly taxInclusive: boolean;
  readonly minQuantity: string;
  readonly unitPrice: string;
  readonly maxDiscount: string;
}

export interface ResolveQuery {
  readonly variantId: string;
  readonly organizationId: string;
  readonly currency: string;
  readonly quantity: string;
  readonly date?: string;
}

/** Catálogo (M03) sobre a API real: o servidor valida, garante a unicidade e resolve os preços. */
@Injectable({ providedIn: 'root' })
export class CatalogApi {
  private readonly api = inject(ApiService);

  categories(): Observable<readonly CategoryDto[]> {
    return this.api.get('product-categories');
  }

  createCategory(body: {
    code: string;
    name: string;
    parentId?: string | null;
  }): Observable<CategoryDto> {
    return this.api.post('product-categories', body);
  }

  updateCategory(
    id: string,
    body: { expectedVersion: number; name?: string; parentId?: string | null },
  ): Observable<CategoryDto> {
    return this.api.patch(`product-categories/${id}`, body);
  }

  products(filter: ProductFilter): Observable<ProductPage> {
    const params: Record<string, string | number | boolean> = {};
    for (const [key, value] of Object.entries(filter)) {
      if (value !== undefined && value !== '') params[key] = value;
    }
    return this.api
      .getWithMeta<readonly ProductDto[]>('products', { params })
      .pipe(map((r) => ({ items: r.data, total: Number(r.meta['total'] ?? r.data.length) })));
  }

  product(id: string): Observable<ProductDto> {
    return this.api.get(`products/${id}`);
  }

  createProduct(body: ProductBody): Observable<ProductDto> {
    return this.api.post('products', body);
  }

  updateProduct(
    id: string,
    expectedVersion: number,
    body: Partial<ProductBody>,
  ): Observable<ProductDto> {
    return this.api.patch(`products/${id}`, { expectedVersion, ...body });
  }

  createVariant(
    productId: string,
    body: { sku: string; barcode?: string | null; attributes?: Attributes },
  ): Observable<VariantDto> {
    return this.api.post(`products/${productId}/variants`, body);
  }

  updateVariant(
    id: string,
    expectedVersion: number,
    body: { barcode?: string | null; attributes?: Attributes; active?: boolean },
  ): Observable<VariantDto> {
    return this.api.patch(`variants/${id}`, { expectedVersion, ...body });
  }

  priceLists(): Observable<readonly PriceListDto[]> {
    return this.api.get('price-lists');
  }

  priceList(id: string): Observable<PriceListDto> {
    return this.api.get(`price-lists/${id}`);
  }

  createPriceList(body: PriceListBody): Observable<PriceListDto> {
    return this.api.post('price-lists', body);
  }

  updatePriceList(
    id: string,
    expectedVersion: number,
    body: Partial<PriceListBody>,
  ): Observable<PriceListDto> {
    return this.api.patch(`price-lists/${id}`, { expectedVersion, ...body });
  }

  addPriceItem(
    priceListId: string,
    body: { variantId: string; minQuantity?: string; unitPrice: string; maxDiscount?: string },
  ): Observable<PriceItemDto> {
    return this.api.post(`price-lists/${priceListId}/items`, body);
  }

  updatePriceItem(
    id: string,
    expectedVersion: number,
    body: { unitPrice?: string; maxDiscount?: string },
  ): Observable<PriceItemDto> {
    return this.api.patch(`price-list-items/${id}`, { expectedVersion, ...body });
  }

  deletePriceItem(id: string): Observable<unknown> {
    return this.api.delete(`price-list-items/${id}`);
  }

  resolvePrice(query: ResolveQuery): Observable<ResolvedPriceDto> {
    const params: Record<string, string> = {};
    for (const [key, value] of Object.entries(query)) if (value) params[key] = value;
    return this.api.get('prices/resolve', { params });
  }
}
