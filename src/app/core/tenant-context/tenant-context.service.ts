import { computed, effect, inject, Injectable, signal } from '@angular/core';
import { map, type Observable, of, switchMap, tap } from 'rxjs';
import { AuthService } from '../auth/auth.service';
import { TenantGateway } from './tenant.gateway';
import type { TenantContext, TenantMembership } from './tenant.model';

const LAST_SLUG_KEY = 'sg-last-tenant';

/** Tenant activo e tenants a que o utilizador pertence. */
@Injectable({ providedIn: 'root' })
export class TenantContextService {
  private readonly gateway = inject(TenantGateway);
  private readonly auth = inject(AuthService);

  /** `null` = ainda não carregado. */
  private readonly _memberships = signal<readonly TenantMembership[] | null>(null);
  private readonly _active = signal<TenantContext | null>(null);

  readonly memberships = computed(() => this._memberships() ?? []);
  readonly active = this._active.asReadonly();
  readonly tenant = computed(() => this._active()?.tenant ?? null);

  constructor() {
    effect(() => {
      if (!this.auth.isAuthenticated()) {
        this._memberships.set(null);
        this._active.set(null);
      }
    });
  }

  loadMemberships(): Observable<readonly TenantMembership[]> {
    const cached = this._memberships();
    if (cached) return of(cached);
    return this.gateway.listMemberships().pipe(tap((list) => this._memberships.set(list)));
  }

  /** Activa o tenant com este slug. Devolve `null` se o utilizador não pertence a ele. */
  activate(slug: string): Observable<TenantContext | null> {
    return this.loadMemberships().pipe(
      switchMap((list) => {
        const membership = list.find((m) => m.tenant.slug === slug);
        if (!membership) return of(null);

        const current = this._active();
        if (current?.tenant.id === membership.tenant.id) return of(current);

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
    this._active.set(null);
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
