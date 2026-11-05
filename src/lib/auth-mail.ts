import type { MailMessage } from './mailer';

/**
 * Plain-text and HTML versions of the two account emails. The HTML keeps the
 * app's black/charcoal palette but stays simple enough for email clients.
 */

function layout(options: {
  heading: string;
  lead: string;
  button: string;
  url: string;
  footnote: string;
}): string {
  return `<!doctype html>
<html>
  <body style="margin:0;padding:0;background:#050506;color:#ffffff;font-family:ui-sans-serif,system-ui,-apple-system,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;">
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#050506;padding:32px 16px;">
      <tr>
        <td align="center">
          <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:520px;background:#09090b;border:1px solid #1e1e24;border-radius:16px;padding:32px;">
            <tr><td style="font-size:13px;letter-spacing:0.14em;text-transform:uppercase;color:#8d8d99;">AutoClipper</td></tr>
            <tr><td style="padding-top:16px;font-size:24px;font-weight:600;color:#ffffff;">${options.heading}</td></tr>
            <tr><td style="padding-top:12px;font-size:14px;line-height:1.6;color:#b4b4bf;">${options.lead}</td></tr>
            <tr><td style="padding-top:24px;">
              <a href="${options.url}" style="display:inline-block;background:#ffffff;color:#050506;text-decoration:none;font-size:14px;font-weight:600;padding:12px 20px;border-radius:10px;">${options.button}</a>
            </td></tr>
            <tr><td style="padding-top:24px;font-size:12px;line-height:1.6;color:#6f6f7b;">${options.footnote}</td></tr>
            <tr><td style="padding-top:12px;font-size:12px;line-height:1.6;color:#6f6f7b;word-break:break-all;">${options.url}</td></tr>
          </table>
        </td>
      </tr>
    </table>
  </body>
</html>`;
}

export function verificationMail(to: string, url: string): MailMessage {
  return {
    to,
    subject: 'Confirm your AutoClipper email',
    text: `Confirm your AutoClipper email\n\nOpen this link to verify your address and activate your account:\n${url}\n\nThis link expires in 24 hours. If you did not create an account, ignore this email.\n`,
    html: layout({
      heading: 'Confirm your email',
      lead: 'Verify this address to activate your AutoClipper account and start clipping.',
      button: 'Confirm email',
      url,
      footnote: 'This link expires in 24 hours. If you did not create an account, ignore this email.',
    }),
  };
}

export function passwordResetMail(to: string, url: string): MailMessage {
  return {
    to,
    subject: 'Reset your AutoClipper password',
    text: `Reset your AutoClipper password\n\nOpen this link to choose a new password:\n${url}\n\nThis link expires in one hour and can only be used once. If you did not ask for a reset, you can ignore this email — your password stays the same.\n`,
    html: layout({
      heading: 'Reset your password',
      lead: 'Choose a new password for your AutoClipper account. The link can be used once.',
      button: 'Choose a new password',
      url,
      footnote:
        'This link expires in one hour. If you did not ask for a reset, ignore this email — your password stays the same.',
    }),
  };
}
