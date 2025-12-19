// src/middleware/rbac.js

export const allowRoles = (...allowed) => (req, res, next) => {
  const roleIdRaw = req.user?.role_id;

  if (roleIdRaw === undefined || roleIdRaw === null) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  const roleId = Number(roleIdRaw);
  const allowedRoles = allowed.map(Number);

  if (!allowedRoles.includes(roleId)) {
    return res.status(403).json({ error: 'Forbidden' });
  }

  next();
};

// helpers (also normalized)
export const canManageCompanies = (roleId) => Number(roleId) === 1; // only super admin
export const canManageShips = (roleId) => [1, 2].includes(Number(roleId)); // super admin/admin
export const canManageUsers = (roleId) => [1, 2, 3].includes(Number(roleId));
export const canCreateIncident = (roleId) => [1, 2, 3, 4].includes(Number(roleId));
export const canEditIncident = (roleId) => [1, 2, 3].includes(Number(roleId)); // crew cannot edit/delete
