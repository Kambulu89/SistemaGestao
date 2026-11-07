/**
 * CSV para exportação: separador `;` (Excel em PT), aspas quando preciso e neutralização de fórmulas (um valor que
 * comece por `= + - @` ou tabulação/CR recebe um apóstrofo, para não ser executado ao abrir a folha).
 */
export function toCsv(headers: string[], rows: unknown[][]): string {
  const cell = (value: unknown) => {
    let text = value === null || value === undefined ? '' : String(value);
    if (/^[=+\-@\t\r]/.test(text)) text = `'${text}`;
    return /[";\n\r]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
  };
  return [headers, ...rows].map((r) => r.map(cell).join(';')).join('\r\n');
}

/** Descarrega texto como ficheiro (com BOM UTF-8, para os acentos abrirem bem). */
export function downloadText(filename: string, text: string, type = 'text/csv;charset=utf-8') {
  const url = URL.createObjectURL(new Blob(['﻿', text], { type }));
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
