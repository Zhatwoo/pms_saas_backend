
const { createClient } = require('@supabase/supabase-js')
require('dotenv').config()

const url = process.env.SUPABASE_URL
const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY

const supabase = createClient(url, serviceKey)

const data = [
  {
    "item_id": "GVFFBH",
    "item_name": "Rolex Submariner",
    "category": "Watches",
    "branch": "BGC Taguig",
    "branch_id": "6f052b78-2937-4451-be72-9b1db15f2981",
    "pawn_date": "2026-04-01",
    "status": "Active"
  },
  {
    "item_id": "HJK889",
    "item_name": "Diamond Ring 2ct",
    "category": "Jewelry",
    "branch": "BGC Taguig",
    "branch_id": "6f052b78-2937-4451-be72-9b1db15f2981",
    "pawn_date": "2026-04-05",
    "status": "Active"
  },
  {
    "item_id": "XCV112",
    "item_name": "iPhone 15 Pro",
    "category": "Electronics",
    "branch": "BGC Taguig",
    "branch_id": "6f052b78-2937-4451-be72-9b1db15f2981",
    "pawn_date": "2026-04-10",
    "status": "Active"
  }
]

async function seed() {
  console.log('Seeding items...')
  const { error } = await supabase.from('pawned_items').insert(data)
  if (error) {
    console.error('Error seeding:', error)
  } else {
    console.log('Successfully seeded 3 items.')
  }
}

seed()
