/**
 * Capabilities, not roles, are what routes check — adding a role later touches
 * this one map instead of every route. Shared so the web app can hide what a
 * role cannot use, while the API stays the only enforcement point.
 */

export const CAPABILITIES = [
  "graph:read",
  "gate:invoke",
  "rationale:confirm",
  "criticality:edit",
  "reflex:revert",
  "connector:manage",
  "apikey:manage",
  "member:manage",
  "audit:read",
  "org:delete",
] as const;

export type Capability = (typeof CAPABILITIES)[number];

export const ROLES = ["owner", "admin", "member", "viewer"] as const;
export type Role = (typeof ROLES)[number];

const VIEWER: Capability[] = ["graph:read"];

const MEMBER: Capability[] = [
  ...VIEWER,
  "gate:invoke",
  "rationale:confirm",
  "criticality:edit",
];

const ADMIN: Capability[] = [
  ...MEMBER,
  "reflex:revert",
  "connector:manage",
  "apikey:manage",
  "member:manage",
  "audit:read",
];

const OWNER: Capability[] = [...ADMIN, "org:delete"];

export const ROLE_CAPABILITIES: Record<Role, readonly Capability[]> = {
  owner: OWNER,
  admin: ADMIN,
  member: MEMBER,
  viewer: VIEWER,
};

export function roleHas(role: Role, capability: Capability): boolean {
  return ROLE_CAPABILITIES[role].includes(capability);
}

export function capabilitiesFor(role: Role): readonly Capability[] {
  return ROLE_CAPABILITIES[role];
}

export function isCapability(value: string): value is Capability {
  return (CAPABILITIES as readonly string[]).includes(value);
}
