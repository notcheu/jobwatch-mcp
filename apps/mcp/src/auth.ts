import { timingSafeEqual } from 'node:crypto';
import type { NextFunction, Request, Response } from 'express';

/** Constant-time comparison that also hides the length of the secret. */
export function safeEqual(a: string, b: string): boolean {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  const length = Math.max(left.length, right.length, 1);
  const paddedLeft = Buffer.alloc(length);
  const paddedRight = Buffer.alloc(length);
  left.copy(paddedLeft);
  right.copy(paddedRight);
  return timingSafeEqual(paddedLeft, paddedRight) && left.length === right.length;
}

const unauthorized = (res: Response): void => {
  res
    .status(401)
    .set('WWW-Authenticate', 'Bearer')
    .json({ jsonrpc: '2.0', error: { code: -32001, message: 'Unauthorized' }, id: null });
};

/**
 * AUTH=front with a shared secret: the OAuth front must present `Authorization: Bearer <secret>`.
 * (babs/mcp-auth-proxy can inject a static upstream Authorization header: VERIFY when the stack is assembled.)
 * Without a secret the router relies on network isolation: it publishes no port and only the front can reach it.
 */
export function requireSharedSecret(secret: string) {
  return (req: Request, res: Response, next: NextFunction): void => {
    const header = req.header('authorization') ?? '';
    const match = /^Bearer (.+)$/.exec(header);
    if (match?.[1] === undefined || !safeEqual(match[1], secret)) {
      unauthorized(res);
      return;
    }
    next();
  };
}

/**
 * AUTH=none (local development, loopback only): refuse requests whose Host header is not the configured loopback
 * host. A web page open in the developer's browser could otherwise reach the no-auth server through DNS rebinding.
 */
export function requireLoopbackHost(allowedHostnames: readonly string[]) {
  return (req: Request, res: Response, next: NextFunction): void => {
    const host = (req.header('host') ?? '').replace(/:\d+$/, '').toLowerCase();
    if (!allowedHostnames.includes(host)) {
      res.status(403).json({ jsonrpc: '2.0', error: { code: -32002, message: 'Forbidden host' }, id: null });
      return;
    }
    next();
  };
}
