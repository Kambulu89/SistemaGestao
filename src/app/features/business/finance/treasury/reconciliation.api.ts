import { inject, Injectable } from '@angular/core';
import { map, type Observable } from 'rxjs';
import { ApiService } from '../../../../core/api/api.service';
import type { Page } from '../../sales/orders/orders.api';

export type MatchState = 'UNMATCHED' | 'PARTIAL' | 'MATCHED';

/** Decimais atravessam a API como texto: nunca `number`. */
export interface StatementLineDto {
  readonly id: string;
  readonly accountId: string;
  readonly batchId: string;
  readonly occurredOn: string;
  readonly amountSigned: string;
  readonly description: string | null;
  readonly reference: string | null;
  readonly matched: string;
  readonly remaining: string;
  readonly state: MatchState;
}

export interface MatchDto {
  readonly id: string;
  readonly statementLineId: string;
  readonly treasuryEntryId: string;
  readonly matchedAmount: string;
  readonly confirmedAt: string;
  readonly undoneAt: string | null;
  readonly undoReason: string | null;
}

export interface StatementLineDetailDto extends StatementLineDto {
  readonly matches: readonly MatchDto[];
}

export interface ReconEntryDto {
  readonly id: string;
  readonly accountId: string;
  readonly paymentReference: string | null;
  readonly partyName: string | null;
  readonly amountSigned: string;
  readonly occurredOn: string;
  readonly matched: string;
  readonly remaining: string;
  readonly state: MatchState;
}

export interface SuggestionDto {
  readonly entryId: string;
  readonly score: number;
  readonly matchableAmount: string;
  readonly reasons: readonly string[];
  readonly entry: ReconEntryDto;
}

export interface BatchDto {
  readonly id: string;
  readonly fileName: string | null;
  readonly lineCount: number;
  readonly skippedCount: number;
  readonly createdAt: string;
}

export interface SummaryDto {
  readonly currency: string;
  readonly bookBalance: string;
  readonly statementTotal: string;
  readonly lines: Counts;
  readonly entries: Counts;
  readonly unmatchedStatementAmount: string;
  readonly unmatchedBookAmount: string;
}

export interface Counts {
  readonly total: number;
  readonly unmatched: number;
  readonly partial: number;
  readonly matched: number;
}

export interface ImportLine {
  readonly occurredOn: string;
  readonly amount: string;
  readonly description?: string;
  readonly reference?: string;
  readonly externalId?: string;
}

export interface ImportResult {
  readonly batch: BatchDto | null;
  readonly imported: number;
  readonly skipped: number;
}

/** Conciliação bancária (M09, 5.2): o extracto nunca altera o livro; só se liga a movimentos que uma pessoa confirma. */
@Injectable({ providedIn: 'root' })
export class ReconciliationApi {
  private readonly api = inject(ApiService);

  private page<T>(path: string, params: Record<string, string | number | undefined>) {
    const clean: Record<string, string | number> = {};
    for (const [key, value] of Object.entries(params)) {
      if (value !== undefined && value !== '') clean[key] = value;
    }
    return this.api
      .getWithMeta<readonly T[]>(path, { params: clean })
      .pipe(
        map((r): Page<T> => ({ items: r.data, total: Number(r.meta['total'] ?? r.data.length) })),
      );
  }

  summary(accountId: string): Observable<SummaryDto> {
    return this.api.get('reconciliations/summary', { params: { accountId } });
  }

  lines(filter: { accountId: string; state?: MatchState; limit?: number; offset?: number }) {
    return this.page<StatementLineDto>('reconciliations/lines', filter);
  }

  line(id: string): Observable<StatementLineDetailDto> {
    return this.api.get(`reconciliations/lines/${id}`);
  }

  suggestions(id: string): Observable<readonly SuggestionDto[]> {
    return this.api.get(`reconciliations/lines/${id}/suggestions`);
  }

  entries(filter: { accountId: string; state?: MatchState; limit?: number; offset?: number }) {
    return this.page<ReconEntryDto>('reconciliations/entries', filter);
  }

  batches(accountId: string) {
    return this.page<BatchDto>('reconciliations/batches', { accountId, limit: 50 });
  }

  importStatement(body: {
    accountId: string;
    fileName?: string;
    lines: readonly ImportLine[];
  }): Observable<ImportResult> {
    return this.api.post('reconciliations/imports', body);
  }

  discardBatch(id: string): Observable<void> {
    return this.api.delete(`reconciliations/batches/${id}`);
  }

  confirm(body: {
    statementLineId: string;
    treasuryEntryId: string;
    amount?: string;
  }): Observable<MatchDto> {
    return this.api.post('reconciliations/matches', body);
  }

  undo(id: string, reason: string): Observable<MatchDto> {
    return this.api.post(`reconciliations/matches/${id}/undo`, { reason });
  }
}
