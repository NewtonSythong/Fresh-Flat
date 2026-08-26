-- Fresh-Flat initial schema.
--
-- Reverse-engineered from application code (model/, controller/, app/api/,
-- utils/supabase/) — the original Supabase project's schema was never
-- committed to this repo (no supabase/migrations, no generated types), and
-- that project became unreachable (owned by a former teammate's account).
-- This migration is a from-scratch rebuild against a fresh, Newton-
-- administered Supabase project. See NewtonProfile's portfolio-site ticket
-- for the redeploy this supports.
--
-- Every column/relationship here is backed by an actual query in the
-- codebase (see the comment above each table). The two embedded selects the
-- app relies on — `ingredients(name)` in model/ingredient.js and
-- `recipes_have_ingredients(...)` in model/recipe.js — require real foreign
-- key constraints for PostgREST to resolve them, not just matching values.
--
-- RLS is intentionally left off on every table: the app already does all
-- authorization itself (filtering by the session user's id server-side via
-- the admin/service-role client or the user's own JWT), matching how the
-- original app evidently ran — every read/write path in model/ and
-- controller/ goes through server-side code, none of it through a
-- browser-side anon-key client with no session context.

-- flats: a household. `id` doubles as the invite token (see
-- model/flat.js's `inviteToken: flatId` and app/api/flat/join/route.js,
-- which resolves an invite token by looking up a flat by `id` directly —
-- there is no separate token column).
create table public.flats (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  admin uuid not null references auth.users (id) on delete cascade,
  created_at timestamptz not null default now()
);

-- flats_have_users: membership junction. A user belongs to at most one flat
-- in practice (see utils/supabase/middleware.js's /chooseFlat redirect
-- logic, which treats "any row" as "already has a flat"), but nothing in
-- the query code requires the DB to enforce that, so it isn't enforced here
-- beyond preventing the same user being added to the same flat twice.
create table public.flats_have_users (
  flat uuid not null references public.flats (id) on delete cascade,
  "user" uuid not null references auth.users (id) on delete cascade,
  created_at timestamptz not null default now(),
  primary key (flat, "user")
);

-- ingredients: the master ingredient list. `name` is the natural key —
-- users_have_ingredients.ingredient and recipes_have_ingredients.ingredient
-- both store ingredient names directly, not a surrogate id (see
-- model/ingredient.js's addNewUserIngredient, which compares against
-- `ingredients.name` before deciding whether to insert a new one).
create table public.ingredients (
  name text primary key
);

-- users_have_ingredients: each user's pantry. No unique constraint on
-- (user, ingredient) — model/ingredient.js's own duplicate check keys on
-- (ingredient, expiry_date), meaning the same ingredient at a different
-- expiry is intentionally a separate row.
create table public.users_have_ingredients (
  id bigint generated always as identity primary key,
  "user" uuid not null references auth.users (id) on delete cascade,
  ingredient text not null references public.ingredients (name) on update cascade,
  expiry_date date not null,
  amount numeric not null,
  unit text not null,
  is_public boolean not null default false
);

-- recipes: AI-generated or saved recipes, scoped to the flat that created
-- them. `created_at` is directly queried (model/recipe.js orders by it).
create table public.recipes (
  id uuid primary key default gen_random_uuid(),
  title text not null,
  instructions text not null,
  preparation_time numeric,
  cooking_time numeric,
  difficulty text,
  created_by uuid references auth.users (id) on delete set null,
  flat uuid not null references public.flats (id) on delete cascade,
  created_at timestamptz not null default now()
);

-- recipes_have_ingredients: a recipe's ingredient list. `ingredient` is
-- free text, NOT a foreign key to ingredients.name — saveRecipeToDatabase
-- in model/recipe.js writes whatever ingredient names the AI response
-- contained, which need not match the user's pantry's ingredient list.
create table public.recipes_have_ingredients (
  id bigint generated always as identity primary key,
  recipe uuid not null references public.recipes (id) on delete cascade,
  ingredient text not null,
  amount numeric,
  unit text
);
