export const TAB_SESSION_HEADER = 'x-medsync-tab-id';
const tabSessionIdPattern = /^[\da-f]{8}-[\da-f]{4}-[1-8][\da-f]{3}-[89ab][\da-f]{3}-[\da-f]{12}$/i;

export const getTabSessionId = (value: unknown): string | undefined =>
  typeof value === 'string' && tabSessionIdPattern.test(value) ? value : undefined;

export const accessCookieName = (tabSessionId: string) => `medsyncAccessToken_${tabSessionId}`;
export const refreshCookieName = (tabSessionId: string) => `medsyncRefreshToken_${tabSessionId}`;
