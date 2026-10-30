import type { Tone } from '../../../../shared/ui/badge/badge';
import { financeError } from './finance-model';
import type { ImportLine, MatchState } from './reconciliation.api';

export { formatDecimal } from './finance-model';

export const MATCH_STATE: Readonly<Record<MatchState, { label: string; tone: Tone }>> = {
  UNMATCHED: { label: 'Por conciliar', tone: 'warning' },
  PARTIAL: { label: 'Parcial', tone: 'brand' },
  MATCHED: { label: 'Conciliado', tone: 'success' },
};

const RECONCILIATION_ERRORS: Readonly<Record<string, string>> = {
  NOT_A_BANK_ACCOUNT: 'Só as contas bancárias têm extracto.',
  ACCOUNT_MISMATCH: 'A linha do extracto e o movimento são de contas diferentes.',
  DIRECTION_MISMATCH: 'Uma entrada não se concilia com uma saída.',
  LINE_FULLY_MATCHED: 'A linha do extracto já está conciliada.',
  ENTRY_FULLY_MATCHED: 'O movimento já está conciliado.',
  EXCEEDS_REMAINING: 'O valor excede o que falta conciliar na linha ou no movimento.',
  PAIR_ALREADY_MATCHED: 'Esta linha já está ligada a este movimento.',
  BATCH_HAS_MATCHES:
    'Há linhas deste extracto já conciliadas: desfaça as correspondências primeiro.',
  DUPLICATE_EXTERNAL_ID: 'Há identificadores repetidos no ficheiro.',
  INVALID_DATE: 'Data inválida no extracto.',
  INVALID_AMOUNT: 'Valor inválido no extracto.',
  ZERO_AMOUNT: 'O valor de uma linha não pode ser zero.',
  TOO_MANY: 'No máximo 1000 linhas por importação.',
  REASON_REQUIRED: 'Indique o motivo.',
};

export function reconciliationError(error: unknown, fallback: string): string {
  const code = (error as { code?: string } | null)?.code;
  if (code && RECONCILIATION_ERRORS[code]) return RECONCILIATION_ERRORS[code];
  const fields = (error as { fieldErrors?: readonly { code: string; message: string }[] } | null)
    ?.fieldErrors;
  if (fields && fields.length > 0) {
    return fields.map((f) => RECONCILIATION_ERRORS[f.code] ?? f.message).join(' ');
  }
  return financeError(error, fallback);
}

// --- leitura do ficheiro CSV do banco ---------------------------------------------------------------

export interface ParsedStatement {
  readonly lines: readonly ImportLine[];
  readonly errors: readonly string[];
}

const plain = (value: string) => value.trim().toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '');

const COLUMN_NAMES: Readonly<Record<string, readonly string[]>> = {
  date: ['data', 'date', 'data movimento', 'data valor', 'data mov'],
  amount: ['valor', 'montante', 'amount', 'quantia'],
  credit: ['credito', 'credit', 'entrada', 'entradas'],
  debit: ['debito', 'debit', 'saida', 'saidas'],
  description: ['descricao', 'description', 'descritivo', 'movimento', 'detalhe'],
  reference: ['referencia', 'reference', 'ref'],
  externalId: ['id', 'identificador', 'id movimento', 'transaction id', 'external id'],
};

/** Datas `AAAA-MM-DD` ou `DD/MM/AAAA` (também com `-` ou `.`); `null` se não forem uma data real. */
export function parseDate(value: string): string | null {
  const text = value.trim();
  const iso = /^(\d{4})-(\d{2})-(\d{2})$/.exec(text);
  const local = /^(\d{1,2})[/.-](\d{1,2})[/.-](\d{4})$/.exec(text);
  let candidate: string;
  if (iso) candidate = text;
  else if (local) {
    candidate = `${local[3]}-${(local[2] ?? '').padStart(2, '0')}-${(local[1] ?? '').padStart(2, '0')}`;
  } else return null;
  const date = new Date(`${candidate}T00:00:00Z`);
  return !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === candidate
    ? candidate
    : null;
}

/**
 * Valor do banco para decimal em texto (nunca `number`): aceita `1.234,56`, `1,234.56`, `1234,5` e o sinal à frente ou
 * entre parêntesis. Devolve `null` se não for um valor com até 4 casas decimais.
 */
export function parseAmount(value: string): string | null {
  let text = value.replace(/\s/g, '').replace(/[A-Za-z]{3}$/, '');
  let negative = false;
  if (/^\(.*\)$/.test(text)) {
    negative = true;
    text = text.slice(1, -1);
  }
  if (text.startsWith('-')) {
    negative = !negative;
    text = text.slice(1);
  } else if (text.startsWith('+')) text = text.slice(1);
  if (text === '' || !/^[\d.,]+$/.test(text)) return null;
  const lastComma = text.lastIndexOf(',');
  const lastDot = text.lastIndexOf('.');
  let decimalAt = Math.max(lastComma, lastDot);
  if (lastComma >= 0 && lastDot < 0 && text.split(',').length > 2) decimalAt = -1;
  if (lastDot >= 0 && lastComma < 0 && text.split('.').length > 2) decimalAt = -1;
  const integer = (decimalAt < 0 ? text : text.slice(0, decimalAt)).replace(/[.,]/g, '');
  const fraction = decimalAt < 0 ? '' : text.slice(decimalAt + 1);
  if (!/^\d{1,15}$/.test(integer) || !/^\d{0,4}$/.test(fraction)) return null;
  const digits = fraction === '' ? integer : `${integer}.${fraction}`;
  if (!/[1-9]/.test(digits)) return digits.replace(/^0+(?=\d)/, '');
  return `${negative ? '-' : ''}${digits.replace(/^0+(?=\d)/, '')}`;
}

function splitRow(row: string, delimiter: string): string[] {
  const cells: string[] = [];
  let current = '';
  let quoted = false;
  for (let i = 0; i < row.length; i++) {
    const char = row[i];
    if (char === '"') {
      if (quoted && row[i + 1] === '"') {
        current += '"';
        i++;
      } else quoted = !quoted;
    } else if (char === delimiter && !quoted) {
      cells.push(current);
      current = '';
    } else current += char;
  }
  cells.push(current);
  return cells.map((c) => c.trim());
}

/** Lê o CSV do banco: primeira linha com os nomes das colunas; `valor` ou `crédito` e `débito`. Sem rede nem servidor. */
export function parseStatementCsv(text: string): ParsedStatement {
  const rows = (text.charCodeAt(0) === 0xfeff ? text.slice(1) : text)
    .split(/\r?\n/)
    .filter((r) => r.trim() !== '');
  if (rows.length < 2) {
    return {
      lines: [],
      errors: ['O ficheiro precisa de uma linha de cabeçalhos e de movimentos.'],
    };
  }
  const first = rows[0] ?? '';
  const delimiter = [';', '\t', ','].find((d) => first.includes(d)) ?? ';';
  const header = splitRow(first, delimiter).map(plain);
  const find = (key: string) => header.findIndex((h) => COLUMN_NAMES[key]?.includes(h));
  const col = {
    date: find('date'),
    amount: find('amount'),
    credit: find('credit'),
    debit: find('debit'),
    description: find('description'),
    reference: find('reference'),
    externalId: find('externalId'),
  };
  const errors: string[] = [];
  if (col.date < 0) errors.push('Falta a coluna da data («data»).');
  if (col.amount < 0 && (col.credit < 0 || col.debit < 0)) {
    errors.push('Falta a coluna do valor («valor») ou as de «crédito» e «débito».');
  }
  if (errors.length > 0) return { lines: [], errors };
  const lines: ImportLine[] = [];
  rows.slice(1).forEach((row, index) => {
    const cells = splitRow(row, delimiter);
    const at = `Linha ${index + 2}`;
    const occurredOn = parseDate(cells[col.date] ?? '');
    if (!occurredOn) {
      errors.push(`${at}: data inválida.`);
      return;
    }
    let amount: string | null;
    if (col.amount >= 0) amount = parseAmount(cells[col.amount] ?? '');
    else {
      const credit = parseAmount(cells[col.credit] || '0');
      const debit = parseAmount(cells[col.debit] || '0');
      const filled = (v: string | null) => v !== null && /[1-9]/.test(v);
      if (credit === null || debit === null || (filled(credit) && filled(debit))) amount = null;
      else if (filled(credit)) amount = credit;
      else amount = filled(debit) ? `-${(debit as string).replace(/^-/, '')}` : '0';
    }
    if (amount === null || !/[1-9]/.test(amount)) {
      errors.push(`${at}: valor inválido ou zero.`);
      return;
    }
    const pick = (i: number) => (i >= 0 && cells[i] ? cells[i] : undefined);
    lines.push({
      occurredOn,
      amount,
      ...(pick(col.description) ? { description: pick(col.description) } : {}),
      ...(pick(col.reference) ? { reference: pick(col.reference) } : {}),
      ...(pick(col.externalId) ? { externalId: pick(col.externalId) } : {}),
    });
  });
  return { lines, errors };
}
