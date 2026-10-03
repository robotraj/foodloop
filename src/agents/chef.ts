// Agent 4 — Chef.
// Turns leftovers into recipes: a "remix" dish the restaurant can serve tomorrow from food the
// router marked for reuse, or ideas for anyone holding leftover ingredients.
import { z } from "zod";
import { config } from "../config.js";
import { askStructured } from "../llm.js";
import type { FoodItem } from "../store.js";

const Recipe = z.object({
  title: z.string().describe("Dish name, max 50 characters"),
  uses: z.array(z.string()).describe("Which of the given leftovers this recipe uses"),
  ingredients: z.array(z.string()).describe("Full ingredient list with rough quantities, leftovers first"),
  steps: z.array(z.string()).describe("3-6 short steps"),
  allergens: z.array(z.string()).describe("EU allergens present, e.g. gluten, milk, egg, nuts. Empty if none."),
  minutes: z.number().int().describe("Total time in minutes"),
});
export type Recipe = z.infer<typeof Recipe>;

const ChefOutput = z.object({ recipes: z.array(Recipe) });

const CHEF_SYSTEM = `You are FoodLoop's chef agent. You turn restaurant leftovers into practical recipes a professional kitchen can make tomorrow.
Rules:
- Build each recipe around the leftovers; add only common pantry ingredients.
- Leftovers must have been kept chilled; say so in the first step when it matters (reheat cooked rice and meat to steaming hot).
- List EU allergens honestly. Keep steps short and concrete.`;

// Offline fallback: a small cookbook keyed on what the leftovers look like.
const COOKBOOK: [RegExp, Omit<Recipe, "uses">][] = [
  [
    /bread|brood|loaves|baguette|croissant|bun/i,
    {
      title: "Savoury bread pudding",
      ingredients: ["leftover bread, cubed", "4 eggs", "400 ml milk", "100 g grated cheese", "1 onion", "salt, pepper, thyme"],
      steps: ["Cube the bread and fry the onion soft.", "Whisk eggs, milk, cheese and seasoning.", "Soak the bread in the mix for 10 minutes.", "Bake at 180 °C for 35 minutes until set and golden."],
      allergens: ["gluten", "egg", "milk"],
      minutes: 50,
    },
  ],
  [
    /rice|rijst|biryani|nasi/i,
    {
      title: "Next-day fried rice",
      ingredients: ["chilled leftover rice", "2 eggs", "frozen peas", "2 spring onions", "soy sauce", "neutral oil"],
      steps: ["Use rice that was chilled within an hour of cooking.", "Scramble the eggs in a hot wok, set aside.", "Stir-fry the rice until steaming hot, add peas and soy.", "Fold the egg and spring onion back in."],
      allergens: ["egg", "soy"],
      minutes: 15,
    },
  ],
  [
    /potato|aardappel|stamppot|fries/i,
    {
      title: "Crispy potato hash",
      ingredients: ["leftover potatoes or stamppot", "1 onion", "paprika", "2 eggs", "parsley"],
      steps: ["Press the potatoes flat in a hot oiled pan.", "Add sliced onion and paprika, fry until crisp underneath.", "Flip in pieces, crack in the eggs and cover until set.", "Finish with parsley."],
      allergens: ["egg"],
      minutes: 20,
    },
  ],
  [
    /fruit|apple|appel|banana|berries|pie/i,
    {
      title: "Spiced fruit compote",
      ingredients: ["leftover fruit, chopped", "2 tbsp sugar", "cinnamon", "lemon juice"],
      steps: ["Simmer fruit with sugar, cinnamon and a splash of water for 15 minutes.", "Add lemon juice to taste.", "Serve with yoghurt or on tomorrow's pastries."],
      allergens: [],
      minutes: 20,
    },
  ],
  [
    /pasta|penne|lasagne|noodle|pad thai/i,
    {
      title: "Baked pasta frittata",
      ingredients: ["leftover pasta or noodles", "6 eggs", "100 g cheese", "handful of greens"],
      steps: ["Reheat the pasta in an oven-proof pan.", "Pour over beaten eggs with cheese and greens.", "Cook on low heat 5 minutes, then bake at 180 °C for 15 minutes.", "Slice into wedges."],
      allergens: ["gluten", "egg", "milk"],
      minutes: 25,
    },
  ],
];

const SOUP: Omit<Recipe, "uses"> = {
  title: "Leftover vegetable soup",
  ingredients: ["leftover vegetables or cooked dishes", "1 onion", "1 l stock", "salt, pepper", "crème fraîche to finish"],
  steps: ["Fry the onion, add the leftovers and stock.", "Simmer 20 minutes, then blend smooth.", "Season and finish with crème fraîche."],
  allergens: ["milk", "celery"],
  minutes: 30,
};

function offlineRecipes(items: FoodItem[]): Recipe[] {
  const recipes = new Map<string, Recipe>();
  for (const item of items) {
    const base = COOKBOOK.find(([re]) => re.test(item.name))?.[1] ?? SOUP;
    const recipe = recipes.get(base.title) ?? { ...base, uses: [] };
    recipe.uses.push(item.name);
    recipes.set(base.title, recipe);
  }
  return [...recipes.values()].slice(0, 2);
}

/** One or two recipes built around the given leftovers. */
export async function suggestRecipes(items: FoodItem[], opts: { cuisine?: string } = {}): Promise<Recipe[]> {
  if (!items.length) return [];
  if (config.offline) return offlineRecipes(items);
  const out = await askStructured({
    system: CHEF_SYSTEM,
    schema: ChefOutput,
    effort: "low",
    prompt: [
      `Leftovers: ${items.map((i) => `${i.portions}x ${i.name}`).join(", ")}`,
      opts.cuisine ? `Restaurant cuisine: ${opts.cuisine}` : "",
      "Suggest 1-2 recipes.",
    ].join("\n"),
  });
  return out.recipes.slice(0, 2);
}
