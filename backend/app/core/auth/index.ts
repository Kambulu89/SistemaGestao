/**
 * API pública do módulo de autenticação. Outros módulos importam **apenas** daqui.
 * A criação de contas está exposta para comandos e seeds; o resto é transporte HTTP.
 */
export type { Principal, User } from '#core/auth/domain/identity'
export { normalizeEmail } from '#core/auth/domain/email'
export { authServices } from '#core/auth/presentation/composition'
export { generateOpaqueToken, hashToken, safeEqual } from '#core/auth/domain/tokens'
