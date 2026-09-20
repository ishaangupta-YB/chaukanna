import { AppError } from './errors';

interface RateLimitEntry {
  count: number;
  resetAt: number;
}

/** In-memory rate limit store. In production, this would be Redis or DynamoDB. */
const store = new Map<string, RateLimitEntry>();

/** Cleanup interval to prevent memory leaks. */
setInterval(() => {
  const now = Date.now();
  for (const [key, entry] of store.entries()) {
    if (entry.resetAt < now) store.delete(key);
  }
}, 60 * 1000);

export interface RateLimitOptions {
  /** Maximum requests allowed in the window */
  max: number;
  /** Window in milliseconds */
  windowMs: number;
  /** Optional custom key prefix */
  prefix?: string;
}

/**
 * Checks and increments rate limit for a key.
 * Throws AppError(429) if limit exceeded.
 */
export async function rateLimit(
  key: string,
  options: RateLimitOptions
): Promise<{ remaining: number; resetAt: number }> {
  const now = Date.now();
  const fullKey = `${options.prefix ?? 'rl'}:${key}`;
  const entry = store.get(fullKey);

  if (!entry || entry.resetAt < now) {
    // First request or window expired
    const resetAt = now + options.windowMs;
    store.set(fullKey, { count: 1, resetAt });
    return { remaining: options.max - 1, resetAt };
  }

  if (entry.count >= options.max) {
    const retryAfter = Math.ceil((entry.resetAt - now) / 1000);
    throw new AppError(429, 'rate_limited', `Too many requests, retry after ${retryAfter}s`);
  }

  entry.count++;
  return { remaining: options.max - entry.count, resetAt: entry.resetAt };
}

/**
 * Creates a rate limiter middleware for route handlers.
 * Uses IP address as the key by default.
 */
export function createRateLimiter(options: RateLimitOptions) {
  return async (request: Request): Promise<{ remaining: number; resetAt: number }> => {
    // Get client IP from headers (works behind proxies like Amplify/ALB)
    const forwarded = request.headers.get('x-forwarded-for');
    const ip = forwarded?.split(',')[0]?.trim() ?? request.headers.get('x-real-ip') ?? 'unknown';
    return rateLimit(ip, options);
  };
}

/**
 * Rate limiter specifically for invite acceptance.
 * Uses token hash as key to prevent token enumeration, falls back to IP.
 */
export async function rateLimitInviteAccept(
  token: string,
  request: Request
): Promise<{ remaining: number; resetAt: number }> {
  // Use a hash of the token as the key to avoid storing the raw token
  const crypto = await import('node:crypto');
  const tokenHash = crypto.createHash('sha256').update(token).digest('hex').slice(0, 16);

  // Also include IP for additional protection
  const forwarded = request.headers.get('x-forwarded-for');
  const ip = forwarded?.split(',')[0]?.trim() ?? request.headers.get('x-real-ip') ?? 'unknown';

  return rateLimit(`invite:${tokenHash}:${ip}`, {
    max: 5,           // 5 attempts
    windowMs: 15 * 60 * 1000, // per 15 minutes
    prefix: 'chaukanna',
  });
}