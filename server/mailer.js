// Sends the sign-in code emails. Which service is used depends on what is configured:
//  - MAIL_FROM + the Microsoft app (AZURE_*): sent through Microsoft 365 (Graph) from that mailbox. The app needs the
//    "Mail.Send" application permission, which should be limited to that one mailbox (see docs/EMAIL-SETUP.md).
//  - MAIL_FROM + RESEND_API_KEY: sent through Resend (resend.com), a sending service with its own limited key.
//  - Neither, in development: the message is printed in the server's log instead of being sent.
//  - Neither, in production: no mailer, and staff can't sign in until one is set up.
export function createMailer(env, { isProd }) {
  const from = env.MAIL_FROM?.trim();

  if (from && env.RESEND_API_KEY) {
    return {
      kind: "resend",
      async send({ to, subject, text }) {
        const res = await fetch("https://api.resend.com/emails", {
          method: "POST",
          headers: { Authorization: `Bearer ${env.RESEND_API_KEY}`, "Content-Type": "application/json" },
          body: JSON.stringify({ from, to: [to], subject, text }),
        });
        if (!res.ok) throw new Error(`Resend ${res.status}: ${(await res.text()).slice(0, 200)}`);
      },
    };
  }

  if (from && env.AZURE_TENANT_ID && env.AZURE_CLIENT_ID && env.AZURE_CLIENT_SECRET) {
    const GRAPH = (env.GRAPH_BASE_URL || "https://graph.microsoft.com/v1.0").replace(/\/$/, "");
    const LOGIN = (env.LOGIN_BASE_URL || "https://login.microsoftonline.com").replace(/\/$/, "");
    let token = null;
    let expires = 0;
    const getToken = async () => {
      if (token && Date.now() < expires - 60_000) return token;
      const res = await fetch(`${LOGIN}/${encodeURIComponent(env.AZURE_TENANT_ID)}/oauth2/v2.0/token`, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          client_id: env.AZURE_CLIENT_ID,
          client_secret: env.AZURE_CLIENT_SECRET,
          scope: "https://graph.microsoft.com/.default",
          grant_type: "client_credentials",
        }),
      });
      if (!res.ok) throw new Error(`Microsoft sign-in for email failed (${res.status})`);
      const data = await res.json();
      token = data.access_token;
      expires = Date.now() + (data.expires_in ?? 3600) * 1000;
      return token;
    };
    return {
      kind: "graph",
      async send({ to, subject, text }) {
        const res = await fetch(`${GRAPH}/users/${encodeURIComponent(from)}/sendMail`, {
          method: "POST",
          headers: { Authorization: `Bearer ${await getToken()}`, "Content-Type": "application/json" },
          body: JSON.stringify({
            message: { subject, body: { contentType: "Text", content: text }, toRecipients: [{ emailAddress: { address: to } }] },
            saveToSentItems: false,
          }),
        });
        if (!res.ok) throw new Error(`Graph sendMail ${res.status}: ${(await res.text()).slice(0, 200)}`);
      },
    };
  }

  if (!isProd) {
    return {
      kind: "console",
      async send({ to, subject, text }) {
        console.log(`[email, development only] To: ${to} | ${subject}\n${text}`);
      },
    };
  }
  return null;
}
