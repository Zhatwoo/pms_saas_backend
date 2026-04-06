export default () => ({
  port: parseInt(process.env.PORT ?? '3000', 10),
  database: {
    host: process.env.DB_HOST || 'localhost',
    port: parseInt(process.env.DB_PORT ?? '5432', 10),
    name: process.env.DB_NAME || 'pms_db',
  },
  jwt: {
    secret: process.env.JWT_SECRET || 'change-me',
    expiresIn: process.env.JWT_EXPIRES_IN || '1d',
  },
});
