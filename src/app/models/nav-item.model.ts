import type { IconName } from './icon.model';

export interface NavItem {
  readonly label: string;
  readonly path: string;
  readonly icon: IconName;
}
