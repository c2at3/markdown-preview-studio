const attempts = new Map();

const WINDOW_MS = 15 * 60 * 1000;
const MAX_ATTEMPTS = 10;

function rateLimit(key) {
  const now = Date.now();
  let entry = attempts.get(key);
  if (!entry || now - entry.start > WINDOW_MS) {
    entry = { count: 0, start: now };
    attempts.set(key, entry);
  }
  entry.count++;
  return entry.count > MAX_ATTEMPTS;
}

function authRateLimiter(req, res, next) {
  const ip = req.ip || req.connection.remoteAddress;
  if (rateLimit(ip)) {
    return res.status(429).json({ error: 'Too many attempts. Try again later.' });
  }
  next();
}

// Cleanup old entries every 10 minutes
setInterval(() => {
  const now = Date.now();
  for (const [key, entry] of attempts) {
    if (now - entry.start > WINDOW_MS) attempts.delete(key);
  }
}, 10 * 60 * 1000);

module.exports = { authRateLimiter };
