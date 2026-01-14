import nodemailer from "nodemailer";

let cachedTransporter = null;

export const createTransporter = () => {
  const host = process.env.SMTP_HOST;
  const port = Number(process.env.SMTP_PORT || 587);
  const secure = String(process.env.SMTP_SECURE || "false") === "true";
  const user = process.env.SMTP_USER;
  const pass = process.env.SMTP_PASS;

  if (!host || !port || !user || !pass) {
    throw new Error("SMTP env not configured (SMTP_HOST/PORT/USER/PASS).");
  }

  return nodemailer.createTransport({
    host,
    port,
    secure,
    auth: { user, pass },
  });
};

const getTransporter = () => {
  if (!cachedTransporter) cachedTransporter = createTransporter();
  return cachedTransporter;
};

export const sendEmail = async ({ to, subject, html }) => {
  const fromName = process.env.MAIL_FROM_NAME || "Fathom Marine";
  const fromEmail = process.env.MAIL_FROM_EMAIL || process.env.SMTP_USER;

  const transporter = getTransporter();

  return transporter.sendMail({
    from: `${fromName} <${fromEmail}>`,
    to,
    subject,
    html,
  });
};

export const isValidEmail = (email) => {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(email || "").trim());
};
