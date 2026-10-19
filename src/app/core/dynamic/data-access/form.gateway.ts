import type { Observable } from 'rxjs';
import type { DefinitionChange } from '../engine/definition-compat';
import type { FormIssue } from '../engine/form-integrity';
import type {
  FormDefinition,
  FormLayout,
  FormMode,
  FormSection,
  ManagedFormDefinition,
} from '../models/form-definition.model';

/** Pedido para criar ou actualizar o rascunho de um formulário do tenant. O tenant vem do contexto. */
export interface SaveFormDraftInput {
  /** Código estável; imutável depois de o formulário existir. */
  readonly key: string;
  readonly entityKey: string;
  readonly name: string;
  readonly description?: string;
  readonly modes: readonly FormMode[];
  readonly isDefault?: boolean;
  readonly layout?: FormLayout;
  readonly sections: readonly FormSection[];
  /** Formulário global de que este é uma cópia personalizada. */
  readonly basedOn?: FormDefinition['basedOn'];
  /** Versão do rascunho (ou da publicada, se ainda não há rascunho) que o cliente viu; `null` = novo. */
  readonly expectedVersion: number | null;
}

/** Resultado da validação no servidor, sem alterar nada. */
export interface FormValidationResult {
  readonly ok: boolean;
  readonly issues: readonly FormIssue[];
  readonly changes: readonly DefinitionChange[];
}

/** Detalhe de um 422 ao guardar ou publicar. */
export interface FormFailure {
  readonly issues: readonly FormIssue[];
}

/**
 * Contrato com o backend para definições de formulários (o Form Registry). O servidor identifica o
 * tenant pelo contexto do pedido e devolve os formulários globais e os do tenant (todas as versões e
 * estados). Criar, publicar e arquivar exigem permissão e são validados no servidor, que repete as
 * verificações do cliente. Nenhuma destas operações grava registos empresariais.
 */
export abstract class FormGateway {
  /** Formulários visíveis ao tenant; `entityKey` restringe a uma entidade. */
  abstract list(entityKey?: string): Observable<readonly ManagedFormDefinition[]>;
  /** Todas as versões de um formulário (histórico), da mais recente para a mais antiga. */
  abstract versions(entityKey: string, key: string): Observable<readonly ManagedFormDefinition[]>;
  /** Cria ou actualiza o rascunho (nova versão se só existir a publicada). */
  abstract saveDraft(input: SaveFormDraftInput): Observable<ManagedFormDefinition>;
  abstract validate(entityKey: string, key: string): Observable<FormValidationResult>;
  abstract publish(entityKey: string, key: string): Observable<ManagedFormDefinition>;
  /** Arquiva a versão publicada (deixa de estar disponível aos utilizadores). */
  abstract archive(entityKey: string, key: string): Observable<ManagedFormDefinition>;
  abstract discardDraft(entityKey: string, key: string): Observable<void>;
}
