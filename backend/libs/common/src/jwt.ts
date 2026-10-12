import jwt from 'jsonwebtoken';
import { config } from './config';

export interface DashboardClaims {
  sub: string; // merchant id
  email: string;
}

const ISSUER = 'payforge';
const AUDIENCE = 'payforge-dashboard';

export function signDashboardToken(claims: DashboardClaims, expiresIn: `${number}h` = '12h'): string {
  return jwt.sign(claims, config.jwtSecret, { algorithm: 'HS256', issuer: ISSUER, audience: AUDIENCE, expiresIn });
}

export function verifyDashboardToken(token: string): DashboardClaims | null {
  try {
    const decoded = jwt.verify(token, config.jwtSecret, {
      algorithms: ['HS256'],
      issuer: ISSUER,
      audience: AUDIENCE,
    }) as jwt.JwtPayload;
    if (typeof decoded.sub !== 'string') return null;
    return { sub: decoded.sub, email: String(decoded.email ?? '') };
  } catch {
    return null;
  }
}
