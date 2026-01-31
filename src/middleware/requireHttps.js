export const requireHttps = (req, res, next) => {
  if (req.method === "OPTIONS") return next();

  // allow local/dev http
  if (process.env.NODE_ENV !== "production") return next();

  const proto = req.headers["x-forwarded-proto"];
  const isSecure = req.secure || proto === "https";
  if (!isSecure) return res.status(403).json({ error: "HTTPS required" });
  next();
  
};

app.use((err, req, res, next) => {
  if (err && err.message === "Not allowed by CORS") {
    return res.status(403).json({ error: "Not allowed by CORS" });
  }
  next(err);
});
