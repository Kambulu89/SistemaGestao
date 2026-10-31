import { inject, Injectable } from '@angular/core';
import type { Observable } from 'rxjs';
import { ApiService } from '../../../core/api/api.service';

export type Nature = 'DEBIT' | 'CREDIT';
export type AccountKind = 'HEADER' | 'POSTING';
export type EntryStatus = 'DRAFT' | 'POSTED' | 'REVERSED';
export type JournalType =
  'GENERAL' | 'SALES' | 'PURCHASES' | 'TREASURY' | 'PAYROLL' | 'OPENING' | 'CLOSING';

export interface OrganizationDto {
  readonly id: string;
  readonly code: string;
  readonly legalName: string;
}

export interface AccountDto {
  readonly id: string;
  readonly organizationId: string;
  readonly code: string;
  readonly name: string;
  readonly accountClass: number;
  readonly nature: Nature;
  readonly kind: AccountKind;
  readonly parentId: string | null;
  readonly requiresCostCenter: boolean;
  readonly requiresParty: boolean;
  readonly active: boolean;
  readonly version: number;
}

export interface PeriodDto {
  readonly id: string;
  readonly fiscalYearId: string;
  readonly number: number;
  readonly startsOn: string;
  readonly endsOn: string;
  readonly status: 'OPEN' | 'CLOSED';
}

export interface FiscalYearDto {
  readonly id: string;
  readonly organizationId: string;
  readonly code: string;
  readonly startsOn: string;
  readonly endsOn: string;
  readonly status: 'OPEN' | 'CLOSED';
  readonly periods: readonly PeriodDto[];
}

export interface JournalDto {
  readonly id: string;
  readonly organizationId: string;
  readonly code: string;
  readonly name: string;
  readonly type: JournalType;
  readonly active: boolean;
  readonly version: number;
}

export interface LineDto {
  readonly id?: string;
  readonly lineNo?: number;
  readonly accountId: string;
  readonly accountCode?: string;
  readonly accountName?: string;
  readonly debit: string;
  readonly credit: string;
  readonly description: string | null;
  readonly costCenterId?: string | null;
  readonly partyId?: string | null;
}

export interface EntryDto {
  readonly id: string;
  readonly organizationId: string;
  readonly journalId: string;
  readonly journalCode?: string;
  readonly number: number | null;
  readonly entryDate: string;
  readonly description: string;
  readonly status: EntryStatus;
  readonly sourceType: string | null;
  readonly sourceKey: string | null;
  readonly reversalOfId: string | null;
  readonly totalDebit: string;
  readonly totalCredit: string;
  readonly postedAt: string | null;
  readonly version: number;
}

export interface EntryDetailDto extends EntryDto {
  readonly lines: readonly LineDto[];
  readonly reversedById: string | null;
}

export interface EntryBody {
  readonly organizationId?: string;
  readonly journalId: string;
  readonly entryDate: string;
  readonly description: string;
  readonly lines: readonly {
    accountId: string;
    debit: string;
    credit: string;
    description: string | null;
  }[];
  readonly version?: number;
}

export interface LedgerDto {
  readonly account: AccountDto;
  readonly from: string;
  readonly to: string;
  readonly opening: string;
  readonly rows: readonly {
    entryId: string;
    entryDate: string;
    journalCode: string;
    number: number | null;
    description: string;
    lineDescription: string | null;
    debit: string;
    credit: string;
    balance: string;
  }[];
  readonly totalDebit: string;
  readonly totalCredit: string;
  readonly closing: string;
}

export interface TrialRowDto {
  readonly accountId: string;
  readonly code: string;
  readonly name: string;
  readonly accountClass: number;
  readonly nature: Nature;
  readonly openingDebit: string;
  readonly openingCredit: string;
  readonly periodDebit: string;
  readonly periodCredit: string;
  readonly closingDebit: string;
  readonly closingCredit: string;
}

export interface TrialBalanceDto {
  readonly organizationId: string;
  readonly from: string;
  readonly to: string;
  readonly rows: readonly TrialRowDto[];
  readonly byClass: readonly {
    accountClass: number;
    periodDebit: string;
    periodCredit: string;
    closingDebit: string;
    closingCredit: string;
  }[];
  readonly totals: {
    openingDebit: string;
    openingCredit: string;
    periodDebit: string;
    periodCredit: string;
    closingDebit: string;
    closingCredit: string;
  };
  readonly asOf: string;
}

export interface PostingEventDto {
  readonly code: string;
  readonly label: string;
  readonly roles: readonly string[];
}

export interface RuleDto {
  readonly id: string;
  readonly organizationId: string;
  readonly eventType: string;
  readonly role: string;
  readonly accountId: string;
  readonly journalId: string;
}

/** Contabilidade geral (ERP E1) sobre a API real. */
@Injectable({ providedIn: 'root' })
export class AccountingApi {
  private readonly api = inject(ApiService);

  organizations(): Observable<readonly OrganizationDto[]> {
    return this.api.get('organizations');
  }

  accounts(organizationId: string): Observable<readonly AccountDto[]> {
    return this.api.get('ledger-accounts', { params: { organizationId } });
  }

  createAccount(body: {
    organizationId: string;
    code: string;
    name: string;
    nature: Nature;
    kind: AccountKind;
    parentId: string | null;
    requiresCostCenter: boolean;
    requiresParty: boolean;
  }): Observable<AccountDto> {
    return this.api.post('ledger-accounts', body);
  }

  updateAccount(
    id: string,
    body: {
      version: number;
      name: string;
      requiresCostCenter: boolean;
      requiresParty: boolean;
      active: boolean;
    },
  ): Observable<AccountDto> {
    return this.api.patch(`ledger-accounts/${id}`, body);
  }

  deleteAccount(id: string): Observable<void> {
    return this.api.delete(`ledger-accounts/${id}`);
  }

  applyTemplate(organizationId: string): Observable<{ accounts: number; journals: number }> {
    return this.api.post('ledger-accounts/apply-template', { organizationId });
  }

  fiscalYears(organizationId: string): Observable<readonly FiscalYearDto[]> {
    return this.api.get('fiscal-years', { params: { organizationId } });
  }

  createFiscalYear(body: {
    organizationId: string;
    code: string;
    startsOn: string;
    endsOn: string;
  }): Observable<FiscalYearDto> {
    return this.api.post('fiscal-years', body);
  }

  closeFiscalYear(id: string): Observable<FiscalYearDto> {
    return this.api.post(`fiscal-years/${id}/close`, {});
  }

  setPeriod(id: string, open: boolean): Observable<PeriodDto> {
    return this.api.post(`fiscal-periods/${id}/${open ? 'reopen' : 'close'}`, {});
  }

  journals(organizationId: string): Observable<readonly JournalDto[]> {
    return this.api.get('journals', { params: { organizationId } });
  }

  createJournal(body: {
    organizationId: string;
    code: string;
    name: string;
    type: JournalType;
  }): Observable<JournalDto> {
    return this.api.post('journals', body);
  }

  entries(filter: {
    organizationId: string;
    status?: string;
    journalId?: string;
    from?: string;
    to?: string;
    limit: number;
    offset: number;
  }): Observable<{ items: readonly EntryDto[]; total: number }> {
    const params: Record<string, string> = {};
    for (const [key, value] of Object.entries(filter))
      if (value !== undefined && value !== '') params[key] = String(value);
    return this.api.get('journal-entries', { params });
  }

  entry(id: string): Observable<EntryDetailDto> {
    return this.api.get(`journal-entries/${id}`);
  }

  createEntry(body: EntryBody): Observable<EntryDetailDto> {
    return this.api.post('journal-entries', body);
  }

  updateEntry(id: string, body: EntryBody): Observable<EntryDetailDto> {
    return this.api.patch(`journal-entries/${id}`, body);
  }

  deleteEntry(id: string): Observable<void> {
    return this.api.delete(`journal-entries/${id}`);
  }

  postEntry(id: string): Observable<EntryDetailDto> {
    return this.api.post(`journal-entries/${id}/post`, {});
  }

  reverseEntry(id: string, entryDate: string): Observable<EntryDetailDto> {
    return this.api.post(`journal-entries/${id}/reverse`, { entryDate });
  }

  ledger(accountId: string, from: string, to: string): Observable<LedgerDto> {
    return this.api.get('ledger', { params: { accountId, from, to } });
  }

  trialBalance(organizationId: string, from: string, to: string): Observable<TrialBalanceDto> {
    return this.api.get('trial-balance', { params: { organizationId, from, to } });
  }

  postingEvents(): Observable<readonly PostingEventDto[]> {
    return this.api.get('posting-events');
  }

  rules(organizationId: string): Observable<readonly RuleDto[]> {
    return this.api.get('posting-rules', { params: { organizationId } });
  }

  saveRule(body: Omit<RuleDto, 'id'>): Observable<RuleDto> {
    return this.api.put('posting-rules', body);
  }

  deleteRule(id: string): Observable<void> {
    return this.api.delete(`posting-rules/${id}`);
  }
}
