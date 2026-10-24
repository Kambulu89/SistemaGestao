import { TestBed } from '@angular/core/testing';
import { of } from 'rxjs';
import { ApiService } from '../../../../core/api/api.service';
import { CatalogApi } from './catalog.api';

describe('CatalogApi', () => {
  function setup() {
    const get = vi.fn(() => of({}));
    const getWithMeta = vi.fn(() => of({ data: [], meta: { total: 7 } }));
    TestBed.configureTestingModule({
      providers: [{ provide: ApiService, useValue: { get, getWithMeta } }],
    });
    return { api: TestBed.inject(CatalogApi), get, getWithMeta };
  }

  it('a resolução de preço não envia a data quando não há data', () => {
    const { api, get } = setup();
    api
      .resolvePrice({
        variantId: 'v1',
        organizationId: 'o1',
        currency: 'AOA',
        quantity: '12',
        date: undefined,
      })
      .subscribe();
    expect(get).toHaveBeenCalledWith('prices/resolve', {
      params: { variantId: 'v1', organizationId: 'o1', currency: 'AOA', quantity: '12' },
    });
  });

  it('a listagem de produtos só envia os filtros preenchidos e devolve o total do servidor', () => {
    const { api, getWithMeta } = setup();
    let total = 0;
    api.products({ q: '', type: 'SERVICE', limit: 100 }).subscribe((page) => (total = page.total));
    expect(getWithMeta).toHaveBeenCalledWith('products', {
      params: { type: 'SERVICE', limit: 100 },
    });
    expect(total).toBe(7);
  });
});
