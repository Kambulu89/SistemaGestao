import { toCsv } from './csv';
import { formatMoney, normalizeMoney } from './money-input';
import { hitLink, type SearchHit } from '../shell/global-search';

describe('dinheiro em texto decimal', () => {
  it('normaliza vírgula, milhares e casas decimais sem usar float', () => {
    expect(normalizeMoney('1 234,5')).toBe('1234.50');
    expect(normalizeMoney('1.234,56')).toBe('1234.56');
    expect(normalizeMoney('0012.3')).toBe('12.30');
    expect(normalizeMoney('-7')).toBe('-7.00');
    expect(normalizeMoney('99999999999999999.99')).toBe('99999999999999999.99');
    expect(normalizeMoney('')).toBeNull();
    expect(normalizeMoney('1,234')).toBeUndefined();
    expect(normalizeMoney('abc')).toBeUndefined();
    expect(normalizeMoney('5', 0)).toBe('5');
  });

  it('formata com separadores portugueses', () => {
    expect(formatMoney('1234567.5')).toBe('1 234 567,50');
    expect(formatMoney('-10.00')).toBe('-10,00');
    expect(formatMoney(null)).toBe('');
  });
});

describe('CSV', () => {
  it('usa ; e aspas quando preciso e neutraliza fórmulas', () => {
    const csv = toCsv(
      ['Nome', 'Valor'],
      [
        ['Ana; Lda', '=1+1'],
        ['Diz "olá"', '@SUM(A1)'],
        [null, '-2'],
      ],
    );
    expect(csv.split('\r\n')).toEqual([
      'Nome;Valor',
      '"Ana; Lda";\'=1+1',
      '"Diz ""olá""";\'@SUM(A1)',
      ";'-2",
    ]);
  });
});

describe('ligações da pesquisa global', () => {
  it('leva cada tipo ao seu ecrã', () => {
    const hit = (h: Partial<SearchHit>) =>
      ({ id: 'x', title: 't', subtitle: null, ...h }) as SearchHit;
    expect(hitLink(hit({ type: 'organization', kind: 'costCenters' }))).toBe(
      '/organizacao/cost-centers/x',
    );
    expect(hitLink(hit({ type: 'member' }))).toBe('/membros/x');
    expect(hitLink(hit({ type: 'role' }))).toBe('/perfis/x');
    expect(hitLink(hit({ type: 'approval_request' }))).toBe('/aprovacoes/pedidos/x');
    expect(hitLink(hit({ type: 'approval_workflow' }))).toBe('/aprovacoes/workflows/x');
  });
});

describe('xlsx', () => {
  it('CRC-32 e ZIP sem compressão com as partes do livro', async () => {
    const { buildXlsx, crc32 } = await import('./xlsx');
    expect(crc32(new TextEncoder().encode('hello'))).toBe(0x3610a686);
    const bytes = buildXlsx('Balanço 2026', [
      [
        { value: 'Rubrica', bold: true },
        { value: 'Valor', bold: true },
      ],
      [{ value: '=HACK()' }, { value: '-1250.50', kind: 'number' }],
      [{ value: 'Caixa & bancos <1>' }, { value: 'não é número', kind: 'number' }],
    ]);
    expect([...bytes.slice(0, 4)]).toEqual([0x50, 0x4b, 0x03, 0x04]);
    const text = new TextDecoder().decode(bytes);
    for (const part of [
      '[Content_Types].xml',
      'xl/workbook.xml',
      'xl/styles.xml',
      'xl/worksheets/sheet1.xml',
    ])
      expect(text).toContain(part);
    expect(text).toContain('<c r="B2" s="2"><v>-1250.50</v></c>');
    expect(text).toContain("'=HACK()");
    expect(text).toContain('Caixa &amp; bancos &lt;1&gt;');
    expect(text).toContain('<sheet name="Balanço 2026"');
    // Fim do arquivo: 6 entradas no directório central.
    const end = new DataView(bytes.buffer, bytes.length - 22);
    expect(end.getUint32(0, true)).toBe(0x06054b50);
    expect(end.getUint16(10, true)).toBe(6);
  });
});
