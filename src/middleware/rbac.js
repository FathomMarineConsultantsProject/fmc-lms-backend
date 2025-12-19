export const canManageCompanies = (roleId) => roleId === 1; // only superadmin
export const canManageShips = (roleId) => roleId === 1 || roleId === 2; // superadmin/admin
export const canManageUsers = (roleId) => roleId === 1 || roleId === 2 || roleId === 3;
export const canCreateIncident = (roleId) => roleId === 1 || roleId === 2 || roleId === 3 || roleId === 4;
export const canEditIncident = (roleId) => roleId === 1 || roleId === 2 || roleId === 3; // crew cannot edit/delete
