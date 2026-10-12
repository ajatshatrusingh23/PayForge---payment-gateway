// Server-only configuration (imported by route handlers, never by client components).
export const API_URL = (process.env.PAYFORGE_API_URL ?? 'http://localhost:8080').replace(/\/$/, '');
export const SESSION_COOKIE = 'pf_session';
