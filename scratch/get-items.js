const { Client } = require('pg');

async function main() {
  const connectionString = "postgresql://postgres.sixbaykcrnjjljatbuia:Inspire%402026%21@aws-1-ap-northeast-1.pooler.supabase.com:5432/postgres?sslmode=require&uselibpqcompat=true";
  const client = new Client({ connectionString });
  await client.connect();
  
  const res = await client.query(`
    select id, item_id, item_name, category, branch_id, status
    from public.pawned_items
  `);
  
  console.log('--- DB PAWNED ITEMS ---');
  console.log(JSON.stringify(res.rows, null, 2));
  
  await client.end();
}

main().catch(console.error);
