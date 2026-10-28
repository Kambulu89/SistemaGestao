import { detailedErrorMessage } from '../../../../core/api/error-message';
import type { MovementKind, ReservationStatus } from './inventory.api';

export const KIND_LABEL: Readonly<Record<MovementKind, string>> = {
  RECEIPT: 'Entrada',
  ISSUE: 'Saída',
  ADJUSTMENT: 'Ajuste',
  TRANSFER_IN: 'Transferência (entrada)',
  TRANSFER_OUT: 'Transferência (saída)',
  REVERSAL: 'Reversão',
};

export const RESERVATION_LABEL: Readonly<Record<ReservationStatus, string>> = {
  ACTIVE: 'Activa',
  CONSUMED: 'Consumida',
  RELEASED: 'Libertada',
  EXPIRED: 'Expirada',
};

export const SOURCE_LABEL: Readonly<Record<string, string>> = {
  ADJUSTMENT: 'Ajuste manual',
  REVERSAL: 'Reversão',
  SALES_ORDER: 'Encomenda de venda',
  SHIPMENT: 'Expedição',
  MANUAL: 'Reserva manual',
};

export const sourceLabel = (type: string): string => SOURCE_LABEL[type] ?? type;

/** Quantidade com sinal, até 6 casas (os mesmos formatos que o servidor exige). */
const SIGNED_QTY = /^-?\d{1,13}(\.\d{1,6})?$/;
const COST = /^\d{1,15}(\.\d{1,4})?$/;
const DATE = /^\d{4}-\d{2}-\d{2}$/;

export const isSignedQuantity = (value: string): boolean => SIGNED_QTY.test(value.trim());
export const isNonZero = (value: string): boolean => /[1-9]/.test(value);
export const isCost = (value: string): boolean => COST.test(value.trim());
export const isDate = (value: string): boolean => DATE.test(value.trim());

/** Tira zeros inúteis à direita («10.500000» → «10.5», «3.000000» → «3»), sem passar por `number`. */
export function trimQuantity(value: string): string {
  if (!value.includes('.')) return value;
  const trimmed = value.replace(/0+$/, '').replace(/\.$/, '');
  return trimmed === '-0' || trimmed === '' ? '0' : trimmed;
}

/** O que o formulário de ajuste devolve de problema (ou `null` se estiver bom). */
export function adjustmentIssue(input: {
  quantityDelta: string;
  unitCost: string;
  reason: string;
  hasVariant: boolean;
  needsLot: boolean;
  lotId: string;
  locationId: string;
}): string | null {
  if (!input.hasVariant) return 'Procure primeiro a variante pelo SKU.';
  if (!input.locationId) return 'Escolha o local.';
  if (input.needsLot && !input.lotId) return 'Este produto tem rastreio por lote: escolha o lote.';
  const delta = input.quantityDelta.trim();
  if (!isSignedQuantity(delta) || !isNonZero(delta)) {
    return 'Quantidade com até 6 casas e diferente de zero (negativa para uma saída).';
  }
  if (input.unitCost.trim() !== '' && !isCost(input.unitCost)) {
    return 'Custo unitário com até 4 casas, não negativo.';
  }
  if (!input.reason.trim()) return 'Indique o motivo.';
  return null;
}

/**
 * Mensagem de um erro do inventário. O servidor devolve o «Disponível: X» como detalhe de campo; junta-se-lhe a frase
 * que o explica, para a mensagem fazer sentido sozinha.
 */
export function inventoryError(error: unknown, fallback: string): string {
  const message = detailedErrorMessage(error, fallback);
  const code = (error as { code?: string } | null)?.code;
  return code === 'INSUFFICIENT_STOCK' && !/insuficiente/i.test(message)
    ? `Stock disponível insuficiente. ${message}`
    : message;
}
