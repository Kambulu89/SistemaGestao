import { describe, expect, it } from 'vitest';
import {
  formatAttributes,
  formatDecimal,
  isMoney,
  isPositiveQuantity,
  isRate,
  parseAttributes,
  stockIssue,
} from './catalog-model';

describe('decimais do catálogo', () => {
  it('dinheiro tem até 4 casas, quantidades até 6 e a taxa fica entre 0 e 1', () => {
    expect(isMoney('1500')).toBe(true);
    expect(isMoney('1500.1234')).toBe(true);
    expect(isMoney('1500.12345')).toBe(false);
    expect(isMoney('-1')).toBe(false);
    expect(isMoney('1,5')).toBe(false);
    expect(isRate('0.15')).toBe(true);
    expect(isRate('1')).toBe(true);
    expect(isRate('1.5')).toBe(false);
  });

  it('a quantidade mínima é estritamente positiva', () => {
    expect(isPositiveQuantity('0.000001')).toBe(true);
    expect(isPositiveQuantity('10')).toBe(true);
    expect(isPositiveQuantity('0')).toBe(false);
    expect(isPositiveQuantity('0.0000001')).toBe(false);
  });

  it('formata sem perder casas decimais', () => {
    expect(formatDecimal('1234567.5000')).toBe('1 234 567,5000');
    expect(formatDecimal('12')).toBe('12');
  });
});

describe('atributos de variante', () => {
  it('lê e escreve pares chave=valor', () => {
    expect(parseAttributes('tamanho=M, cor=azul')).toEqual({ tamanho: 'M', cor: 'azul' });
    expect(parseAttributes('')).toEqual({});
    expect(formatAttributes({ tamanho: 'M', cor: 'azul' })).toBe('tamanho=M, cor=azul');
  });

  it('recusa pares mal formados', () => {
    expect(parseAttributes('tamanho')).toBeNull();
    expect(parseAttributes('=M')).toBeNull();
    expect(parseAttributes('tamanho=')).toBeNull();
  });
});

describe('regras de stock do produto', () => {
  it('um serviço não controla stock e lotes exigem controlar stock', () => {
    expect(stockIssue('SERVICE', true, 'NONE')).not.toBeNull();
    expect(stockIssue('SERVICE', false, 'LOT')).not.toBeNull();
    expect(stockIssue('GOODS', false, 'LOT')).not.toBeNull();
    expect(stockIssue('GOODS', true, 'SERIAL')).toBeNull();
    expect(stockIssue('SERVICE', false, 'NONE')).toBeNull();
  });
});
