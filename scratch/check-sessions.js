const { Client } = require('pg');

async function main() {
  const connectionString = "postgresql://postgres.sixbaykcrnjjljatbuia:Inspire%402026%21@aws-1-ap-northeast-1.pooler.supabase.com:5432/postgres?sslmode=require&uselibpqcompat=true";
  const client = new Client({ connectionString });
  await client.connect();
  
  const sessions = await client.query(`
    select id, branch_id, business_date, status, starting_balance, ending_balance
    from public.branch_business_sessions
    order by business_date desc
    limit 5
  `);
  
  console.log('--- DB BUSINESS SESSIONS ---');
  console.log(JSON.stringify(sessions.rows, null, 2));

  const balances = await client.query(`
    select id, branch_id, record_date, starting_balance, ending_balance
    from public.daily_balances
    order by record_date desc
    limit 5
  `);
  
  console.log('--- DB DAILY BALANCES ---');
  console.log(JSON.stringify(balances.rows, null, 2));
  
  await client.end();
}

main().catch(console.error);
