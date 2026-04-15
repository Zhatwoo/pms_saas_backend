
const { createClient } = require('@supabase/supabase-js')
require('dotenv').config()

const url = process.env.SUPABASE_URL
const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY

const supabase = createClient(url, serviceKey)

const data = [
  {
    "item_id": "SALE-001",
    "item_name": "Gold Necklace 18k",
    "category": "Jewelry",
    "branch": "BGC Taguig",
    "branch_id": "6f052b78-2937-4451-be72-9b1db15f2981",
    "available_date": "2026-04-12",
    "price": 25000,
    "status": "Available"
  },
  {
    "item_id": "SALE-002",
    "item_name": "Samsung S24 Ultra",
    "category": "Electronics",
    "branch": "BGC Taguig",
    "branch_id": "6f052b78-2937-4451-be72-9b1db15f2981",
    "available_date": "2026-04-13",
    "price": 65000,
    "status": "Available"
  }
]

async function seed() {
  console.log('Seeding sale items...')
  const { error } = await supabase.from('sale_items').insert(data)
  if (error) {
    console.error('Error seeding:', error)
  } else {
    console.log('Successfully seeded 2 sale items.')
  }
}

seed()
