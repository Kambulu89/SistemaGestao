import { describe, expect, it } from 'vitest';
import {
  attributesText,
  categoryPaths,
  conversionLabel,
  decimalText,
  emptyProductForm,
  gtinValid,
  parseAttributes,
  priceLabel,
  productPayload,
} from './inventory-model';

describe('modelo do catálogo', () => {
  it('valida o dígito GTIN e aceita códigos internos', () => {
    expect(gtinValid('4006381333931')).toBe(true);
    expect(gtinValid('4006381333932')).toBe(false);
    expect(gtinValid('96385074')).toBe(true);
    expect(gtinValid('INT-001')).toBe(true);
  });

  it('decimais como texto e conversões legíveis', () => {
    expect(decimalText(' 1,25 ')).toBe('1.25');
    expect(decimalText('')).toBeNull();
    expect(conversionLabel('CX', '24', 'UN')).toBe('1 CX = 24 UN');
    expect(conversionLabel('G', '0.001', 'KG')).toBe('1 G = 0,001 KG');
  });

  it('caminho das categorias', () => {
    const list = [
      {
        id: 'a',
        version: 1,
        code: 'M',
        name: 'Mercadorias',
        parentId: null,
        accountingClass: null,
        status: 'ACTIVE' as const,
      },
      {
        id: 'b',
        version: 1,
        code: 'B',
        name: 'Bebidas',
        parentId: 'a',
        accountingClass: null,
        status: 'ACTIVE' as const,
      },
    ];
    expect(categoryPaths(list).map((c) => c.label)).toEqual([
      'Mercadorias',
      'Mercadorias › Bebidas',
    ]);
  });

  it('serviços e kits não levam dados de stock; só os kits levam componentes', () => {
    const f = {
      ...emptyProductForm(),
      sku: ' s1 ',
      name: 'Serviço',
      productType: 'SERVICE' as const,
      trackLots: true,
      minStock: '5',
      salePrice: '100,5',
      currency: 'aoa',
      components: [{ componentId: 'x', quantity: '1' }],
    };
    const p = productPayload(f);
    expect(p['trackLots']).toBe(false);
    expect(p['minStock']).toBeNull();
    expect(p['components']).toEqual([]);
    expect(p['salePrice']).toBe('100.5');
    expect(p['currency']).toBe('AOA');
    const kit = productPayload({
      ...f,
      productType: 'KIT',
      components: [{ componentId: 'x', quantity: '1,5' }],
    });
    expect(kit['components']).toEqual([{ componentId: 'x', quantity: '1.5' }]);
    expect(productPayload({ ...f, salePrice: '' })['currency']).toBeNull();
  });

  it('atributos de variantes em texto', () => {
    expect(parseAttributes('Cor = Azul; Tamanho=M')).toEqual({ Cor: 'Azul', Tamanho: 'M' });
    expect(attributesText({ Cor: 'Azul', Tamanho: 'M' })).toBe('Cor=Azul; Tamanho=M');
  });

  it('preço com 2 a 4 casas', () => {
    expect(priceLabel('150.5000', 'AOA')).toBe('150,50 AOA');
    expect(priceLabel('1234.1234')).toBe('1 234,1234');
    expect(priceLabel(null)).toBe('—');
  });
});
