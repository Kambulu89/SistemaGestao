/** API pública da administração da plataforma (D-033). Outros módulos importam **apenas** daqui. */
export {
  PLATFORM_PERMISSIONS,
  isPlatformPermission,
  type PlatformPermission,
} from '#platform/administration/domain/platform'
export { administrationServices } from '#platform/administration/presentation/composition'
