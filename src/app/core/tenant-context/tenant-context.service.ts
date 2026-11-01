import { computed, effect, inject, Injectable, InjectionToken, signal } from '@angular/core';
import { map, type Observable, of, Subject, switchMap, tap } from 'rxjs';
import { AuthService } from '../auth/auth.service';
import { TenantGateway } from './tenant.gateway';
import type { TenantContext, TenantMembership } from './tenant.model';

const LAST_SLUG_KEY = 'sg-last-tenant';

/**
 * Serviços que guardam dados de um tenant (caches, rascunhos, subscrições) registam aqui como se
 * limpam. São chamados sempre que o tenant activo muda ou a sessão termina.
 */
export const TENANT_SCOPE_RESETTERS = new InjectionToken<readonly (() => void)[]>(
  'TENANT_SCOPE_RESETTERS',
);

/** Tenant activo e tenants a que o utilizador pertence. */
@Injectable({ providedIn: 'root' })
export class TenantContextService {
  private readonly gateway = inject(TenantGateway);
  private readonly auth = inject(AuthService);
  private readonly resetters = inject(TENANT_SCOPE_RESETTERS, { optional: true }) ?? [];

  /** `null` = ainda não carregado. */
  private readonly _memberships = signal<readonly TenantMembership[] | null>(null);
  private readonly _active = signal<TenantContext | null>(null);

  readonly memberships = computed(() => this._memberships() ?? []);
  readonly active = this._active.asReadonly();
  readonly tenant = computed(() => this._active()?.tenant ?? null);

  /**
   * Emite quando o tenant activo vai mudar (ou deixa de haver tenant): cancela os pedidos em curso
   * do tenant anterior e limpa o que dele esteja em memória.
   */
  readonly switched$ = new Subject<void>();

  constructor() {
    effect(() => {
      if (!this.auth.isAuthenticated()) {
        this._memberships.set(null);
        this.leaveTenant();
      }
    });
  }

  loadMemberships(): Observable<readonly TenantMembership[]> {
    const cached = this._memberships();
    if (cached) return of(cached);
    return this.gateway.listMemberships().pipe(tap((list) => this._memberships.set(list)));
  }

  /** Volta a pedir as organizações do utilizador (ex.: depois de aceitar um convite). */
  refreshMemberships(): Observable<readonly TenantMembership[]> {
    this._memberships.set(null);
    return this.loadMemberships();
  }

  /** Activa o tenant com este slug. Devolve `null` se o utilizador não pertence a ele. */
  activate(slug: string): Observable<TenantContext | null> {
    return this.loadMemberships().pipe(
      switchMap((list) => {
        const membership = list.find((m) => m.tenant.slug === slug);
        if (!membership) return of(null);

        const current = this._active();
        if (current?.tenant.id === membership.tenant.id) return of(current);

        // Troca de tenant: nada do anterior (pedidos, caches) sobrevive nem chega ao ecrã novo.
        if (current) this.leaveTenant();
        return this.gateway.loadContext(membership.tenant.id).pipe(
          tap((context) => {
            this._active.set(context);
            this.rememberSlug(slug);
          }),
        );
      }),
    );
  }

  /** Sai do contexto de tenant (ex.: ao entrar na administração da plataforma). */
  deactivate(): void {
    this.leaveTenant();
  }

  /** Cancela os pedidos do tenant que sai, limpa os seus dados em memória e deixa de ter tenant activo. */
  private leaveTenant(): void {
    if (this._active() === null) return;
    this.switched$.next();
    this._active.set(null);
    for (const reset of this.resetters) reset();
  }

  /** Slug do último tenant usado, se ainda for válido; senão o primeiro disponível. */
  preferredSlug(): Observable<string | null> {
    return this.loadMemberships().pipe(
      map((list) => {
        const last = this.readSlug();
        return (
          list.find((m) => m.tenant.slug === last)?.tenant.slug ?? list[0]?.tenant.slug ?? null
        );
      }),
    );
  }

  private rememberSlug(slug: string): void {
    try {
      localStorage.setItem(LAST_SLUG_KEY, slug);
    } catch {
      // Ignorar: apenas conveniência.
    }
  }

  private readSlug(): string | null {
    try {
      return localStorage.getItem(LAST_SLUG_KEY);
    } catch {
      return null;
    }
  }
}
