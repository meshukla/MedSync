import { env } from '../config/env';

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
    throw new Error(`Brevo rejected the verification email (${response.status}).`);
  }
};
