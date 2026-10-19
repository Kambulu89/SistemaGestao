export interface NavItem {
  readonly label: string;
  /** Caminho absoluto. */
  readonly path: string;
  readonly icon: string;
  /** Activo só em correspondência exacta do URL. */
  readonly exact?: boolean;
}

export interface NavGroup {
  readonly id: string;
  readonly label?: string;
  readonly items: readonly NavItem[];
}

export interface Breadcrumb {
  readonly label: string;
  readonly path: string;
}
