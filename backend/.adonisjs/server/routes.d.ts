import '@adonisjs/core/types/http'

type ParamValue = string | number | bigint | boolean

export type ScannedRoutes = {
  ALL: {
    'health.show': { paramsTuple?: []; params?: {} }
    'auth.login': { paramsTuple?: []; params?: {} }
    'account.forgot_password': { paramsTuple?: []; params?: {} }
    'account.reset_password': { paramsTuple?: []; params?: {} }
    'invitation.accept': { paramsTuple?: []; params?: {} }
    'auth.me': { paramsTuple?: []; params?: {} }
    'auth.logout': { paramsTuple?: []; params?: {} }
    'account.sessions': { paramsTuple?: []; params?: {} }
    'account.revoke_session': { paramsTuple: [ParamValue]; params: {'id': ParamValue} }
    'roles.permissions': { paramsTuple?: []; params?: {} }
    'context.show': { paramsTuple?: []; params?: {} }
    'roles.mine': { paramsTuple?: []; params?: {} }
    'roles.index': { paramsTuple?: []; params?: {} }
    'roles.show': { paramsTuple: [ParamValue]; params: {'id': ParamValue} }
    'roles.store': { paramsTuple?: []; params?: {} }
    'roles.update': { paramsTuple: [ParamValue]; params: {'id': ParamValue} }
    'roles.destroy': { paramsTuple: [ParamValue]; params: {'id': ParamValue} }
    'members.index': { paramsTuple?: []; params?: {} }
    'members.show': { paramsTuple: [ParamValue]; params: {'id': ParamValue} }
    'members.invite': { paramsTuple?: []; params?: {} }
    'members.suspend': { paramsTuple: [ParamValue]; params: {'id': ParamValue} }
    'members.reactivate': { paramsTuple: [ParamValue]; params: {'id': ParamValue} }
    'members.assign_role': { paramsTuple: [ParamValue]; params: {'id': ParamValue} }
    'members.unassign_role': { paramsTuple: [ParamValue,ParamValue]; params: {'id': ParamValue,'assignmentId': ParamValue} }
    'organization.index': { paramsTuple: [ParamValue]; params: {'kind': ParamValue} }
    'organization.show': { paramsTuple: [ParamValue,ParamValue]; params: {'kind': ParamValue,'id': ParamValue} }
    'organization.store': { paramsTuple: [ParamValue]; params: {'kind': ParamValue} }
    'organization.update': { paramsTuple: [ParamValue,ParamValue]; params: {'kind': ParamValue,'id': ParamValue} }
    'tenant_subscription.show': { paramsTuple?: []; params?: {} }
    'platform.features': { paramsTuple?: []; params?: {} }
    'platform.plans': { paramsTuple?: []; params?: {} }
    'platform.create_plan': { paramsTuple?: []; params?: {} }
    'platform.plan': { paramsTuple: [ParamValue]; params: {'id': ParamValue} }
    'platform.update_plan': { paramsTuple: [ParamValue]; params: {'id': ParamValue} }
    'platform.publish_plan': { paramsTuple: [ParamValue]; params: {'id': ParamValue} }
    'platform.retire_plan': { paramsTuple: [ParamValue]; params: {'id': ParamValue} }
    'platform.tenants': { paramsTuple?: []; params?: {} }
    'platform.create_tenant': { paramsTuple?: []; params?: {} }
    'platform.update_tenant': { paramsTuple: [ParamValue]; params: {'id': ParamValue} }
    'platform.subscription': { paramsTuple: [ParamValue]; params: {'id': ParamValue} }
    'platform.start_subscription': { paramsTuple: [ParamValue]; params: {'id': ParamValue} }
    'platform.set_override': { paramsTuple: [ParamValue,ParamValue]; params: {'id': ParamValue,'feature': ParamValue} }
    'platform.remove_override': { paramsTuple: [ParamValue,ParamValue]; params: {'id': ParamValue,'feature': ParamValue} }
    'platform.transition_subscription': { paramsTuple: [ParamValue]; params: {'id': ParamValue} }
  }
  GET: {
    'health.show': { paramsTuple?: []; params?: {} }
    'auth.me': { paramsTuple?: []; params?: {} }
    'account.sessions': { paramsTuple?: []; params?: {} }
    'roles.permissions': { paramsTuple?: []; params?: {} }
    'context.show': { paramsTuple?: []; params?: {} }
    'roles.mine': { paramsTuple?: []; params?: {} }
    'roles.index': { paramsTuple?: []; params?: {} }
    'roles.show': { paramsTuple: [ParamValue]; params: {'id': ParamValue} }
    'members.index': { paramsTuple?: []; params?: {} }
    'members.show': { paramsTuple: [ParamValue]; params: {'id': ParamValue} }
    'organization.index': { paramsTuple: [ParamValue]; params: {'kind': ParamValue} }
    'organization.show': { paramsTuple: [ParamValue,ParamValue]; params: {'kind': ParamValue,'id': ParamValue} }
    'tenant_subscription.show': { paramsTuple?: []; params?: {} }
    'platform.features': { paramsTuple?: []; params?: {} }
    'platform.plans': { paramsTuple?: []; params?: {} }
    'platform.plan': { paramsTuple: [ParamValue]; params: {'id': ParamValue} }
    'platform.tenants': { paramsTuple?: []; params?: {} }
    'platform.subscription': { paramsTuple: [ParamValue]; params: {'id': ParamValue} }
  }
  HEAD: {
    'health.show': { paramsTuple?: []; params?: {} }
    'auth.me': { paramsTuple?: []; params?: {} }
    'account.sessions': { paramsTuple?: []; params?: {} }
    'roles.permissions': { paramsTuple?: []; params?: {} }
    'context.show': { paramsTuple?: []; params?: {} }
    'roles.mine': { paramsTuple?: []; params?: {} }
    'roles.index': { paramsTuple?: []; params?: {} }
    'roles.show': { paramsTuple: [ParamValue]; params: {'id': ParamValue} }
    'members.index': { paramsTuple?: []; params?: {} }
    'members.show': { paramsTuple: [ParamValue]; params: {'id': ParamValue} }
    'organization.index': { paramsTuple: [ParamValue]; params: {'kind': ParamValue} }
    'organization.show': { paramsTuple: [ParamValue,ParamValue]; params: {'kind': ParamValue,'id': ParamValue} }
    'tenant_subscription.show': { paramsTuple?: []; params?: {} }
    'platform.features': { paramsTuple?: []; params?: {} }
    'platform.plans': { paramsTuple?: []; params?: {} }
    'platform.plan': { paramsTuple: [ParamValue]; params: {'id': ParamValue} }
    'platform.tenants': { paramsTuple?: []; params?: {} }
    'platform.subscription': { paramsTuple: [ParamValue]; params: {'id': ParamValue} }
  }
  POST: {
    'auth.login': { paramsTuple?: []; params?: {} }
    'account.forgot_password': { paramsTuple?: []; params?: {} }
    'account.reset_password': { paramsTuple?: []; params?: {} }
    'invitation.accept': { paramsTuple?: []; params?: {} }
    'auth.logout': { paramsTuple?: []; params?: {} }
    'roles.store': { paramsTuple?: []; params?: {} }
    'members.invite': { paramsTuple?: []; params?: {} }
    'members.suspend': { paramsTuple: [ParamValue]; params: {'id': ParamValue} }
    'members.reactivate': { paramsTuple: [ParamValue]; params: {'id': ParamValue} }
    'members.assign_role': { paramsTuple: [ParamValue]; params: {'id': ParamValue} }
    'organization.store': { paramsTuple: [ParamValue]; params: {'kind': ParamValue} }
    'platform.create_plan': { paramsTuple?: []; params?: {} }
    'platform.publish_plan': { paramsTuple: [ParamValue]; params: {'id': ParamValue} }
    'platform.retire_plan': { paramsTuple: [ParamValue]; params: {'id': ParamValue} }
    'platform.create_tenant': { paramsTuple?: []; params?: {} }
    'platform.start_subscription': { paramsTuple: [ParamValue]; params: {'id': ParamValue} }
    'platform.transition_subscription': { paramsTuple: [ParamValue]; params: {'id': ParamValue} }
  }
  DELETE: {
    'account.revoke_session': { paramsTuple: [ParamValue]; params: {'id': ParamValue} }
    'roles.destroy': { paramsTuple: [ParamValue]; params: {'id': ParamValue} }
    'members.unassign_role': { paramsTuple: [ParamValue,ParamValue]; params: {'id': ParamValue,'assignmentId': ParamValue} }
    'platform.remove_override': { paramsTuple: [ParamValue,ParamValue]; params: {'id': ParamValue,'feature': ParamValue} }
  }
  PATCH: {
    'roles.update': { paramsTuple: [ParamValue]; params: {'id': ParamValue} }
    'organization.update': { paramsTuple: [ParamValue,ParamValue]; params: {'kind': ParamValue,'id': ParamValue} }
    'platform.update_plan': { paramsTuple: [ParamValue]; params: {'id': ParamValue} }
    'platform.update_tenant': { paramsTuple: [ParamValue]; params: {'id': ParamValue} }
  }
  PUT: {
    'platform.set_override': { paramsTuple: [ParamValue,ParamValue]; params: {'id': ParamValue,'feature': ParamValue} }
  }
}
declare module '@adonisjs/core/types/http' {
  export interface RoutesList extends ScannedRoutes {}
}