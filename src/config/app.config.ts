export default () => ({
  port: parseInt(process.env.PORT ?? '4000', 10),
  /** When set, binding retries on EADDRINUSE if the primary PORT is taken (e.g. stray nest start). */
  portFallback: process.env.PORT_FALLBACK
    ? parseInt(process.env.PORT_FALLBACK, 10)
    : undefined,
  supabase: {
    url: process.env.SUPABASE_URL || '',
    anonKey: process.env.SUPABASE_ANON_KEY || '',
    serviceRoleKey: process.env.SUPABASE_SERVICE_ROLE_KEY || '',
    jwtSecret: process.env.SUPABASE_JWT_SECRET || '',
  },
  jwt: {
    secret: process.env.SUPABASE_JWT_SECRET || '',
    expiresIn: process.env.JWT_EXPIRES_IN || '1d',
  },
  passwordChange: {
    secret: process.env.PASSWORD_CHANGE_SECRET || '',
  },
});
