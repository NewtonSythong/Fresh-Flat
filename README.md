# Fresh-Flat

A household management app for flatmates: shared pantry tracking with expiry
dates, and AI-generated recipes based on what's actually in the flat.

**Live demo:** https://fresh-flat.vercel.app/

## Background

Fresh-Flat was built as team coursework at the University of Otago. It's a
team project, not a solo one — see "My contribution" below for the parts I
personally built.

## Features

- Email/password authentication (Supabase), with SSR middleware and
  JWT-protected routes
- Invite-token flat creation and joining, with admin roles and per-flat
  data isolation for multiple flats/users
- Shared pantry tracking with expiry dates, scoped to each flat
- AI-generated recipes (via the OpenAI API) from the ingredients currently
  in the pantry

## My contribution

I built the flat and invite CRUD API (`app/api/flat/`), and the
join/leave-flat features — invite-token flat creation and joining, admin
roles, and the multi-user isolation between flats.

## Tech stack

Next.js (App Router), Supabase (Postgres, auth, SSR), OpenAI API, React.

## Running it locally

1. Clone the repo and install dependencies:
   ```
   git clone https://github.com/NewtonSythong/Fresh-Flat.git
   cd Fresh-Flat/FreshFlat
   npm install
   ```
2. Create a `.env` file in the project root with:
   ```
   NEXT_PUBLIC_SUPABASE_URL=
   NEXT_PUBLIC_SUPABASE_ANON_KEY=
   SUPABASE_SERVICE_ROLE_KEY=
   OPENAI_API_KEY=
   ```
   The Supabase values come from your own Supabase project (free tier at
   [supabase.com](https://supabase.com) — Project Settings → API). The
   OpenAI key comes from [platform.openai.com](https://platform.openai.com/api-keys).
3. Run the dev server:
   ```
   npm run dev
   ```
