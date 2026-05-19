const { Client } = require('pg');

async function main() {
  const connectionString = "postgresql://postgres.sixbaykcrnjjljatbuia:Inspire%402026%21@aws-1-ap-northeast-1.pooler.supabase.com:5432/postgres?sslmode=require&uselibpqcompat=true";
  const client = new Client({ connectionString });
  await client.connect();
  
  const res = await client.query(`
    select email, role, account_status
    from public.users
  `);
  
  console.log('--- DATABASE USERS ---');
  console.log(JSON.stringify(res.rows, null, 2));
  
  await client.end();
}

main().catch(console.error);
