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
