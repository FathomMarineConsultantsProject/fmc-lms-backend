export const requireHttps = (req, res, next) => {
  if (req.method === "OPTIONS") return next();

  // allow local/dev http
  if (process.env.NODE_ENV !== "production") return next();

  const proto = (req.headers["x-forwarded-proto"] || "").split(",")[0].trim();
  const isSecure = req.secure || proto === "https";
  if (!isSecure) return res.status(403).json({ error: "HTTPS required" });

  next();
};
