// src/middleware/scope.js
export const buildScope = (req, tableAlias = '') => {
  const a = tableAlias ? `${tableAlias}.` : '';
  const role = Number(req.user?.role_id);

  if (role === 1) return { where: 'TRUE', params: [] };

  if (role === 2) {
    return { where: `${a}company_id = $1`, params: [req.user.company_id] };
  }

  if (role === 3) {
    return {
      where: `${a}company_id = $1 AND ${a}ship_id = $2`,
      params: [req.user.company_id, req.user.ship_id],
    };
  }

  // role 4 => only own records (certificates)
  return { where: `${a}user_id = $1`, params: [req.user.user_id] };
};