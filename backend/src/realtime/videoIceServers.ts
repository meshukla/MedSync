import { createHmac } from 'node:crypto';
import { env } from '../config/env';

export const getVideoIceServers = (userId: string) => {
  if (env.turnUrls.length === 0) return [];

  const expiresAt = Math.floor(Date.now() / 1000) + env.turnCredentialTtlSeconds;
  const username = `${expiresAt}:${userId}`;
  const credential = createHmac('sha1', env.turnSharedSecret).update(username).digest('base64');

  return env.turnUrls.map((urls) => ({ urls, username, credential }));
};
