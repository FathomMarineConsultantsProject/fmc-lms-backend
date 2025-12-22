import jwt from 'jsonwebtoken';
export const requireAuth = (req, res, next) => {
  try {
    const header = req.headers.authorization || '';
    const [type, token] = header.split(' ');

    if (type !== 'Bearer' || !token) {
      return res.status(401).json({ error: 'Missing or invalid Authorization header' });
    }

    const secret = process.env.JWT_SECRET;
    if (!secret) return res.status(500).json({ error: 'JWT_SECRET missing in .env' });

    const payload = jwt.verify(token, secret);
    if (process.env.NODE_ENV !== "production") {
      console.log("AUTH PAYLOAD:", payload);
    }


    // Attach to request for later use
    req.user = payload;
    next();
  } catch (err) {
    return res.status(401).json({ error: 'Invalid or expired token' });
  }
};
