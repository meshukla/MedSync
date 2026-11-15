import { env } from '../config/env';

const brevoRejectionMessage = async (response: Response, emailType: string) => {
  const responseBody = await response.text();
  let detail = '';
  if (responseBody) {
    try {
      const payload: unknown = JSON.parse(responseBody);
      if (typeof payload === 'object' && payload !== null) {
        const message = 'message' in payload && typeof payload.message === 'string' ? payload.message : '';
        const code = 'code' in payload && typeof payload.code === 'string' ? payload.code : '';
        detail = [message, code].filter(Boolean).join(' ');
      }
    } catch {
      // Brevo may return an empty or non-JSON error body.
    }
  }
  const detailMessage = detail ? ` Brevo says: ${detail}` : '';

  if (response.status === 401) {
    return `Brevo rejected the ${emailType} email (401 Unauthorized). Check BREVO_API_KEY in backend/.env; use a valid Brevo v3 API key, then restart the backend.${detailMessage}`;
  }
  if (response.status === 403) {
    return `Brevo rejected the ${emailType} email (403 Forbidden). Check that the sender is verified and permitted in your Brevo account.${detailMessage}`;
  }
  return `Brevo rejected the ${emailType} email (${response.status}). Check the API key and verified sender configuration.${detailMessage}`;
};

export const sendVerificationEmail = async (email: string, code: string) => {
  if (!env.brevoApiKey || !env.brevoSenderEmail) {
    throw new Error('Brevo API key and verified sender email must be configured.');
  }

  const response = await fetch('https://api.brevo.com/v3/smtp/email', {
    method: 'POST',
    headers: {
      accept: 'application/json',
      'api-key': env.brevoApiKey,
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      sender: { email: env.brevoSenderEmail, name: 'MedSync' },
      to: [{ email }],
      subject: 'Verify your MedSync email',
      textContent: `Your MedSync verification code is ${code}. It expires in 10 minutes.`,
    }),
  });

  if (!response.ok) {
    throw new Error(await brevoRejectionMessage(response, 'verification'));
  }
};
