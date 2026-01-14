import { sendEmail, isValidEmail } from "../utils/mailer.js";

export const sendTestMail = async (req, res) => {
  try {
    const { to } = req.body;

    if (!to || !isValidEmail(to)) {
      return res.status(400).json({ error: "Valid 'to' email is required." });
    }

    await sendEmail({
      to,
      subject: "Fathom Marine | SMTP Test",
      html: `<div style="font-family:Arial,sans-serif;">
              <h3>SMTP test successful ✅</h3>
              <p>This email was sent from the FMC-LMS backend using Gmail SMTP.</p>
            </div>`,
    });

    return res.json({ message: "Test mail sent successfully." });
  } catch (e) {
    console.error(e);
    return res.status(500).json({
      error: "Test mail failed.",
      details: String(e?.message || e),
    });
  }
};
