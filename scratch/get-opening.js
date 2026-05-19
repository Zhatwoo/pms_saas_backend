const { Client } = require('pg');

async function main() {
  const connectionString = "postgresql://postgres.sixbaykcrnjjljatbuia:Inspire%402026%21@aws-1-ap-northeast-1.pooler.supabase.com:5432/postgres?sslmode=require&uselibpqcompat=true";
  const client = new Client({ connectionString });
  await client.connect();
  
  const res = await client.query(`
    select id, branch_id, opening_date, starting_cash, status, employee_id
    from public.daily_opening
    order by opening_date desc
    limit 10
  `);
  
  console.log('--- DB DAILY OPENINGS ---');
  console.log(JSON.stringify(res.rows, null, 2));
  
  await client.end();
}

main().catch(console.error);
