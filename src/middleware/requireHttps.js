export const requireHttps = (req, res, next) => {
  const proto = req.headers["x-forwarded-proto"]; // set by Vercel/Proxies
  if (proto && proto !== "https") {
    return res.status(403).json({ error: "HTTPS required" });
  }
  return next();
};
