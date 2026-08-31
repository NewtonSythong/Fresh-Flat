import { createClient } from '@/utils/supabase/server';
import OpenAI from 'openai';

// Recipe generation runs on OpenRouter's free tier rather than on OpenAI
// directly. OpenRouter speaks the Chat Completions API, not OpenAI's Responses
// API, so the SDK is pointed at its base URL and the call below uses
// chat.completions. Same arrangement as Note-Pilot, which uses this model.
const OPENROUTER_BASE_URL = 'https://openrouter.ai/api/v1';

// Free-tier models are fast when a provider has capacity and return 429 when
// it doesn't, so a single model is not dependable enough to sit behind a demo.
// These are tried in order; the first to produce a schema-valid recipe wins.
//
// Both are non-reasoning models, which matters more than raw speed here:
// reasoning models (Note-Pilot's nvidia/nemotron-3.5-lightning:free among
// them) stream their chain-of-thought into message.content and hit the token
// ceiling before emitting any JSON, which produced 170s+ calls and no usable
// output. Note-Pilot tolerates that because it renders prose; this route has
// to JSON.parse the result.
//
// Override with RECIPE_MODELS (comma-separated) without touching this file.
const RECIPE_MODELS = (
  process.env.RECIPE_MODELS ??
  'liquid/lfm-2.5-2.6b:free,openrouter/free'
)
  .split(',')
  .map((model) => model.trim())
  .filter(Boolean);

// The shape app/(protected)/recipe/create/page.js JSON.parses. It is sent as
// response_format for models that honour it AND restated in the prompt for
// those that don't: free models treat a schema as a hint at best, which is why
// parseRecipe below cannot assume it was obeyed.
const RECIPE_SCHEMA = {
  type: 'object',
  required: [
    'title',
    'instructions',
    'preparation_time',
    'cooking_time',
    'ingredients',
  ],
  additionalProperties: false,
  properties: {
    title: { type: 'string', description: 'The title of the recipe.' },
    instructions: {
      type: 'string',
      description:
        'A step-by-step list of instructions for preparing the recipe.',
    },
    preparation_time: {
      type: 'number',
      description: 'The preparation time in minutes.',
    },
    cooking_time: {
      type: 'number',
      description: 'The cooking time in minutes.',
    },
    ingredients: {
      type: 'array',
      description: 'A list of ingredients required for the recipe.',
      // Inlined rather than a $defs/$ref pair: smaller models routinely fail
      // to resolve internal references.
      items: {
        type: 'object',
        required: ['name', 'amount', 'unit'],
        additionalProperties: false,
        properties: {
          name: { type: 'string', description: 'The name of the ingredient.' },
          amount: {
            type: 'number',
            description: 'The amount of the ingredient.',
          },
          unit: {
            type: 'string',
            description: 'The unit of measurement for the amount.',
          },
        },
      },
    },
  },
};

// Pull the first balanced JSON object out of a model response. Free models
// wrap JSON in prose or markdown fences often enough that a bare JSON.parse
// on the raw text is not safe.
function extractJsonObject(text) {
  const withoutFences = String(text ?? '')
    .replace(/^\s*```(?:json)?/i, '')
    .replace(/```\s*$/, '')
    .trim();

  const start = withoutFences.indexOf('{');
  if (start === -1) return null;

  let depth = 0;
  let inString = false;
  let escaped = false;

  for (let i = start; i < withoutFences.length; i++) {
    const char = withoutFences[i];

    if (escaped) {
      escaped = false;
      continue;
    }
    if (char === '\\' && inString) {
      escaped = true;
      continue;
    }
    if (char === '"') inString = !inString;
    if (inString) continue;

    if (char === '{') depth++;
    if (char === '}') {
      depth--;
      if (depth === 0) {
        try {
          return JSON.parse(withoutFences.slice(start, i + 1));
        } catch {
          return null;
        }
      }
    }
  }
  return null;
}

// "15", 15, and "15 minutes" all have to become 15.
function toNumber(value) {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  const match = String(value ?? '').match(/-?\d+(?:\.\d+)?/);
  return match ? Number(match[0]) : null;
}

// Normalise a parsed response into exactly the shape the create page and
// saveRecipeToDatabase expect, or throw so the caller can retry. Deviations
// handled here are ones free models actually produce: instructions as an
// array of steps, times as strings, amounts as strings.
function parseRecipe(raw) {
  const recipe = extractJsonObject(raw);
  if (!recipe || typeof recipe !== 'object') {
    throw new Error('response contained no JSON object');
  }

  const title = typeof recipe.title === 'string' ? recipe.title.trim() : '';

  const instructions = Array.isArray(recipe.instructions)
    ? recipe.instructions.map((step) => String(step).trim()).join('\n')
    : typeof recipe.instructions === 'string'
      ? recipe.instructions.trim()
      : '';

  const ingredients = (
    Array.isArray(recipe.ingredients) ? recipe.ingredients : []
  )
    .map((item) => ({
      name: String(item?.name ?? '').trim(),
      amount: toNumber(item?.amount),
      unit: String(item?.unit ?? '').trim(),
    }))
    .filter((item) => item.name !== '');

  if (!title) throw new Error('response had no title');
  if (!instructions) throw new Error('response had no instructions');
  if (ingredients.length === 0) throw new Error('response had no ingredients');

  return {
    title,
    instructions,
    preparation_time: toNumber(recipe.preparation_time),
    cooking_time: toNumber(recipe.cooking_time),
    ingredients,
  };
}

export async function generateRecipeWithAi(ingredients, difficulty) {
  const apiKey = process.env.OPENROUTER_API_KEY;
  if (!apiKey) {
    throw new Error(
      'OPENROUTER_API_KEY is not set — recipe generation cannot run. Get a key at https://openrouter.ai/keys.'
    );
  }

  const openai = new OpenAI({
    apiKey,
    baseURL: OPENROUTER_BASE_URL,
  });

  const messages = [
    {
      role: 'system',
      content:
        'You are a helpful assistant that provides recipes in a structured JSON format. You take the ingredients from the request and generate a delicious recipe based on them. Only use ingredients you have been told to. Respond with a single JSON object and nothing else — no prose, no markdown fences. It must match this schema exactly: ' +
        JSON.stringify(RECIPE_SCHEMA),
    },
    {
      role: 'user',
      content:
        'Generate me a recipe for one or two persons with the difficulty: ' +
        difficulty +
        '. You are only allowed to use the following ingredients and the maximum amount of them. Ensure the ingredient names that you include in your response are exactly as I provided. You do not have to use all of the ingredients: ' +
        ingredients,
    },
  ];

  // Each model gets two shots: free models ignore the schema often enough that
  // one is unreliable, and showing a model its own malformed output usually
  // fixes the retry. A model that is rate-limited or erroring is abandoned
  // immediately rather than retried, since the next one is the better bet.
  //
  // Returned as a string because the create page JSON.parses it —
  // re-stringifying the normalised object guarantees that parse succeeds.
  let lastError = new Error('no models configured');

  for (const model of RECIPE_MODELS) {
    const conversation = [...messages];

    for (let attempt = 0; attempt < 2; attempt++) {
      let content;

      try {
        const response = await openai.chat.completions.create({
          model,
          stream: false,
          messages: conversation,
          response_format: {
            type: 'json_schema',
            json_schema: {
              name: 'recipe',
              strict: true,
              schema: RECIPE_SCHEMA,
            },
          },
          temperature: 0.7,
          max_tokens: 2048,
          top_p: 1,
        });
        content = response.choices?.[0]?.message?.content ?? '';
      } catch (error) {
        // 429 (no free capacity) or a provider 5xx — try the next model.
        lastError = error;
        console.error(`Recipe model ${model} unavailable: ${error.message}`);
        break;
      }

      try {
        return JSON.stringify(parseRecipe(content));
      } catch (error) {
        lastError = error;
        console.error(
          `Recipe model ${model} attempt ${attempt + 1} returned unusable output: ${error.message}`
        );
        conversation.push(
          { role: 'assistant', content: String(content).slice(0, 2000) },
          {
            role: 'user',
            content:
              'That was not valid. ' +
              error.message +
              '. Reply with ONLY the JSON object matching the schema — no prose, no markdown fences.',
          }
        );
      }
    }
  }

  throw new Error(
    `AI returned an unusable recipe after trying ${RECIPE_MODELS.length} model(s): ${lastError.message}`
  );
}

export async function getAllRecipesOfFlatWithFilters(
  orderIsAscending,
  titleIncludes,
  cookingTimeIsAscending,
  preparation_time
) {
  const supabase = await createClient();

  const { data, error } = await supabase
    .from('recipes')
    .select('*')
    .ilike('title', `%${titleIncludes}%`)
    .order('created_at', { ascending: orderIsAscending })
    .order('cooking_time', { ascending: cookingTimeIsAscending })
    .order('preparation_time', {
      ascending: preparation_time,
    });

  if (error) {
    console.error('Error fetching recipes:', error);
    return null;
  }
  return data;
}

export async function saveRecipeToDatabase(
  title,
  instructions,
  preparation_time,
  cooking_time,
  ingredients,
  difficulty
) {
  const supabase = await createClient();

  const user = await supabase.auth.getUser();
  let userId = null;
  if (!user.error) {
    console.error('Error fetching user:', user.error);
    userId = user.data.user.id;
  }
  const flatOfUser = await supabase
    .from('flats_have_users')
    .select()
    .eq('user', userId);

  const saveRecipe = await supabase
    .from('recipes')
    .insert([
      {
        title: title,
        instructions: instructions,
        preparation_time: preparation_time,
        cooking_time: cooking_time,
        created_by: userId,
        flat: flatOfUser.data[0].flat,
        difficulty: difficulty,
      },
    ])
    .select();

  if (saveRecipe.error) {
    console.error('Error saving recipe:', saveRecipe.error);
    return null;
  }

  console.log('Recipe saved:', saveRecipe);
  const ingredientsData = ingredients.map((ingredient) => ({
    recipe: saveRecipe.data[0].id,
    ingredient: ingredient.name,
    amount: ingredient.amount,
    unit: ingredient.unit,
  }));

  const saveIngredients = await supabase
    .from('recipes_have_ingredients')
    .insert(ingredientsData);

  if (saveIngredients.error) {
    console.error('Error saving ingredients:', saveIngredients.error);
    return null;
  }

  // return the recipe id
  return saveRecipe.data[0].id;
}

export async function getRecipeByID(id) {
  const supabase = await createClient();

  // const user = await supabase.auth.getUser();
  // console.log('USER ID: ' + user.data.user.id);

  // if (user.error) {
  //   console.error('Error fetching user: ', user.error);
  //   return null;
  // }

  const { data, error } = await supabase
    .from('recipes')
    .select(
      'title, instructions, preparation_time, cooking_time, difficulty, recipes_have_ingredients(ingredient, amount, unit) '
    )
    .eq('id', id);

  if (error) {
    console.error('Error fetching recipe ID: ' + id + ': ', error);
    return null;
  }

  return data[0];
}
