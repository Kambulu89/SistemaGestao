import { defineEntity, type FieldInput } from './define-entity';
import { decimalPlaces, mimeAccepted } from './validation';
import { validateRecordData } from './validation';
import type { FieldValue } from '../models/field-definition.model';

const check = (field: FieldInput, value: FieldValue | undefined, required = false) => {
  const entity = defineEntity({
    key: 'x',
    tenantId: 't',
    names: { singular: 'X', plural: 'X' },
    icon: 'cube',
    fields: [{ ...field, required } as FieldInput],
  });
  return validateRecordData(entity, { [field.key]: value }, { mode: 'create' }).map(
    (i) => i.message,
  );
};

describe('validações inerentes ao tipo', () => {
  it('url: só http(s)', () => {
    const f: FieldInput = { type: 'url', key: 'site', label: 'Site' };
    expect(check(f, 'https://exemplo.pt/a?b=1')).toEqual([]);
    expect(check(f, 'ftp://exemplo.pt')).toEqual([
      'O endereço tem de começar por http:// ou https://.',
    ]);
    expect(check(f, 'javascript:alert(1)')).toEqual([
      'O endereço tem de começar por http:// ou https://.',
    ]);
    expect(check(f, 'não é um url')).toEqual(['Introduza um endereço web válido.']);
  });

  it('currency: moeda com precisão explícita (por omissão 2 casas)', () => {
    const f: FieldInput = { type: 'currency', key: 'valor', label: 'Valor', currency: 'EUR' };
    expect(check(f, 10.5)).toEqual([]);
    expect(check(f, 10.555)).toEqual(['No máximo 2 casas decimais.']);
    expect(check({ ...f, scale: 3 } as FieldInput, 10.555)).toEqual([]);
    expect(check({ ...f, scale: 0 } as FieldInput, 1.5)).toEqual(['No máximo 0 casas decimais.']);
  });

  it('decimal: respeita a escala quando definida; number só aceita inteiros', () => {
    expect(check({ type: 'decimal', key: 'd', label: 'D', scale: 1 }, 1.25)).toEqual([
      'No máximo 1 casas decimais.',
    ]);
    expect(check({ type: 'decimal', key: 'd', label: 'D' }, 1.123456)).toEqual([]);
    expect(check({ type: 'number', key: 'n', label: 'N' }, 1.5)).toEqual([
      'Indique um número inteiro.',
    ]);
    expect(check({ type: 'number', key: 'n', label: 'N' }, 3)).toEqual([]);
  });

  it('conta casas decimais sem erros de vírgula flutuante', () => {
    expect([0.1 + 0.2, 1.005, 100, 12.5, 1e-7].map(decimalPlaces)).toEqual([17, 3, 0, 1, 7]);
  });

  it('checkbox: obrigatório significa "tem de estar marcada"', () => {
    const f: FieldInput = { type: 'checkbox', key: 'aceito', label: 'Aceito os termos' };
    expect(check(f, false, true)).toEqual(['Tem de marcar esta opção.']);
    expect(check(f, null, true)).toEqual(['Tem de marcar esta opção.']);
    expect(check(f, true, true)).toEqual([]);
    expect(check(f, false, false)).toEqual([]);
  });

  it('boolean obrigatório aceita false (é um valor)', () => {
    expect(check({ type: 'boolean', key: 'b', label: 'B' }, false, true)).toEqual([]);
  });

  it('radio e select só aceitam as opções definidas', () => {
    const options = [
      { value: 'a', label: 'A' },
      { value: 'b', label: 'B', active: false },
    ];
    expect(check({ type: 'radio', key: 'r', label: 'R', options }, 'a')).toEqual([]);
    expect(check({ type: 'radio', key: 'r', label: 'R', options }, 'z')).toEqual([
      'Opção inválida.',
    ]);
    expect(check({ type: 'multiselect', key: 'm', label: 'M', options }, ['a', 'z'])).toEqual([
      'Opção inválida.',
    ]);
    // Uma opção inactiva continua a ser válida para ler dados antigos.
    expect(check({ type: 'select', key: 's', label: 'S', options }, 'b')).toEqual([]);
  });

  describe('ficheiros e imagens', () => {
    const pdf = { name: 'a.pdf', size: 1000, contentType: 'application/pdf' };
    const png = { name: 'a.png', size: 1000, contentType: 'image/png' };

    it('valida tipo MIME, tamanho e número de ficheiros', () => {
      const f: FieldInput = {
        type: 'file',
        key: 'doc',
        label: 'Doc',
        accept: ['application/pdf'],
        maxSizeBytes: 2000,
      };
      expect(check(f, [pdf])).toEqual([]);
      expect(check(f, [png])).toEqual(['"a.png": tipo de ficheiro não permitido.']);
      expect(check(f, [{ ...pdf, size: 5000 }])).toEqual([
        '"a.pdf": excede o tamanho máximo permitido.',
      ]);
      expect(check(f, [pdf, pdf])).toEqual(['Só é permitido um ficheiro.']);
      expect(check({ ...f, multiple: true } as FieldInput, [pdf, pdf])).toEqual([]);
    });

    it('imagem: por omissão só aceita image/*', () => {
      const f: FieldInput = { type: 'image', key: 'foto', label: 'Foto' };
      expect(check(f, [png])).toEqual([]);
      expect(check(f, [pdf])).toEqual(['"a.pdf": tipo de ficheiro não permitido.']);
    });

    it('padrões MIME com wildcard', () => {
      expect(mimeAccepted('image/webp', ['image/*'])).toBe(true);
      expect(mimeAccepted('application/pdf', ['image/*'])).toBe(false);
      expect(mimeAccepted('application/pdf', ['image/*', 'application/pdf'])).toBe(true);
    });
  });
});
