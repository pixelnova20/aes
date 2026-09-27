export const USER_ROLES = {
  student: "student",
  teacher: "teacher",
  ta: "ta",
  superAdmin: "super_admin",
} as const;

export type UserRole = (typeof USER_ROLES)[keyof typeof USER_ROLES];

export function isUserRole(value: string): value is UserRole {
  return Object.values(USER_ROLES).some((role) => role === value);
}
