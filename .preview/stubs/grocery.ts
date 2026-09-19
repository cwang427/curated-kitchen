import type { GroceryCategory, GroceryItem } from '../../src/lib/types'

function mk(
  id: string, name: string, category: GroceryCategory,
  quantity: number | null, unit: string | null, checked = false,
): GroceryItem {
  return { id, name, canonical: id, quantity, quantityMax: null, unit, category, checked, note: null, addedBy: null, createdAt: null, updatedAt: null }
}

const FIXTURE: GroceryItem[] = [
  mk('onion', 'yellow onion', 'produce', 3, null),
  mk('garlic', 'garlic', 'produce', 6, 'clove'),
  mk('orange', 'orange', 'produce', 4, null),
  mk('short_ribs', 'bone-in short ribs', 'meat', 5, 'lb'),
  mk('butter', 'unsalted butter', 'dairy', 2, 'tbsp'),
  mk('soy_sauce', 'low-sodium soy sauce', 'condiments', 1, 'cup'),
  mk('honey', 'honey', 'condiments', 0.5, 'cup'),
  mk('spaghetti', 'spaghetti', 'pantry', 0.5, 'lb', true),
  mk('pepper', 'black pepper', 'spices', null, null, true),
]

export function useGroceryList() {
  return { items: FIXTURE, loading: false, error: null }
}
export async function addToList() {
  return { created: 0, updated: 0 }
}
export async function quickAdd() {}
export async function toggleItem() {}
export async function removeItem() {}
export async function clearChecked() {
  return 0
}
