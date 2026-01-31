export const requireHttps = (req, res, next) => {
  // ✅ allow preflight always
  if (req.method === "OPTIONS") return next();

  const proto = req.headers["x-forwarded-proto"];
  const isSecure = req.secure || proto === "https";

  if (!isSecure) {
    return res.status(403).json({ error: "HTTPS required" });
  }
  return next();
};
