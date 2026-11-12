import { createHmac, timingSafeEqual } from 'crypto';
import { cookies } from 'next/headers';

const ADMIN_SESSION_COOKIE = 'admin_session';
const DEFAULT_ADMIN_USERNAME = 'admin';
const SESSION_TTL_MS = 24 * 60 * 60 * 1000;

function getSessionSecret(): string {
  const secret = process.env.ADMIN_SESSION_SECRET ?? process.env.ADMIN_SECRET;
  if (!secret) {
    throw new Error('ADMIN_SESSION_SECRET or ADMIN_SECRET must be set');
  }
  return secret;
}

function sign(raw: string): string {
  return createHmac('sha256', getSessionSecret()).update(raw).digest('hex');
}

function getExpectedUsername(): string {
  return process.env.ADMIN_USERNAME ?? DEFAULT_ADMIN_USERNAME;
}

function getExpectedPassword(): string | null {
  return process.env.ADMIN_PASSWORD ?? null;
}

function parseSession(value: string | undefined): { user: string; expiresAt: number; signature: string } | null {
  if (!value) return null;
  const [user, expiresAtRaw, signature] = value.split('.');
  const expiresAt = Number(expiresAtRaw);
  if (!user || !Number.isFinite(expiresAt) || !signature) return null;
  return { user, expiresAt, signature };
}

export async function createAdminSession(username: string): Promise<void> {
  const expiresAt = Date.now() + SESSION_TTL_MS;
  const raw = `${username}.${expiresAt}`;
  const signature = sign(raw);
  const store = await cookies();
  store.set(ADMIN_SESSION_COOKIE, `${raw}.${signature}`, {
    httpOnly: true,
    sameSite: 'lax',
    secure: process.env.NODE_ENV === 'production',
    path: '/',
    expires: new Date(expiresAt),
  });
}

export async function clearAdminSession(): Promise<void> {
  const store = await cookies();
  store.set(ADMIN_SESSION_COOKIE, '', {
    httpOnly: true,
    sameSite: 'lax',
    secure: process.env.NODE_ENV === 'production',
    path: '/',
    maxAge: 0,
  });
}

export async function isAdminSessionValid(): Promise<boolean> {
  const store = await cookies();
  const session = parseSession(store.get(ADMIN_SESSION_COOKIE)?.value);
  if (!session) return false;
  if (session.expiresAt < Date.now()) return false;
  if (session.user !== getExpectedUsername()) return false;

  const raw = `${session.user}.${session.expiresAt}`;
  const expected = sign(raw);
  const actualBuf = Buffer.from(session.signature, 'utf8');
  const expectedBuf = Buffer.from(expected, 'utf8');
  if (actualBuf.length !== expectedBuf.length) return false;

  return timingSafeEqual(actualBuf, expectedBuf);
}

export function validateAdminCredentials(username: string, password: string): boolean {
  const expectedPassword = getExpectedPassword();
  if (!expectedPassword) return false;
  return username === getExpectedUsername() && password === expectedPassword;
}

export async function isAdminRequestAuthorized(request: Request): Promise<boolean> {
  const expectedSecret = process.env.ADMIN_SECRET;
  const providedSecret = request.headers.get('x-admin-secret');
  if (expectedSecret && providedSecret === expectedSecret) {
    return true;
  }

  return isAdminSessionValid();
}
