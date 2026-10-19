import { VEHICLE_V2 } from '../../mock/mock-entities';
import {
  defaultEntityPermissions,
  ENTITY_OPERATIONS,
  entityPermissionDefinitions,
  evaluateOperation,
} from './entity-permissions';

const can =
  (...granted: string[]) =>
  (p: string) =>
    granted.includes(p);

describe('entity permissions (RBAC + ABAC)', () => {
  it('derives IAM permission keys from the entity key', () => {
    expect(defaultEntityPermissions('vehicle')).toEqual({
      read: 'entities.vehicle.read',
      create: 'entities.vehicle.create',
      update: 'entities.vehicle.update',
      delete: 'entities.vehicle.delete',
      export: 'entities.vehicle.export',
      approve: 'entities.vehicle.approve',
      transition: 'entities.vehicle.transition',
    });
    expect(VEHICLE_V2.permissions.operations).toEqual(defaultEntityPermissions('vehicle'));
  });

  it('declares one permission per operation for the IAM catalog', () => {
    const definitions = entityPermissionDefinitions(VEHICLE_V2);
    expect(definitions).toHaveLength(ENTITY_OPERATIONS.length);
    expect(definitions.find((d) => d.key === 'entities.vehicle.delete')?.name).toBe(
      'Eliminar viaturas',
    );
  });

  it('denies without the RBAC permission', () => {
    expect(evaluateOperation(VEHICLE_V2, 'update', can())).toEqual({
      allowed: false,
      denied: 'permission',
    });
    expect(evaluateOperation(VEHICLE_V2, 'update', can('entities.vehicle.update'))).toEqual({
      allowed: true,
    });
  });

  it('applies the ABAC policy: only inactive vehicles can be deleted', () => {
    const granted = can('entities.vehicle.delete');
    expect(
      evaluateOperation(VEHICLE_V2, 'delete', granted, { status: 'available', data: {} }),
    ).toEqual({
      allowed: false,
      denied: 'policy',
      message: 'Só é possível eliminar viaturas inactivas.',
    });
    expect(
      evaluateOperation(VEHICLE_V2, 'delete', granted, { status: 'inactive', data: {} }),
    ).toEqual({ allowed: true });
  });

  it('RBAC still wins over a permissive policy outcome', () => {
    expect(
      evaluateOperation(VEHICLE_V2, 'delete', can(), { status: 'inactive', data: {} }).denied,
    ).toBe('permission');
  });

  it('without a record, policies are not evaluated (list-level checks)', () => {
    expect(evaluateOperation(VEHICLE_V2, 'delete', can('entities.vehicle.delete')).allowed).toBe(
      true,
    );
  });
});
