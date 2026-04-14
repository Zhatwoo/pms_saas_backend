export default () => ({
  port: parseInt(process.env.PORT ?? '4000', 10),
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
});
