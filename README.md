# Lovable-Hackathon---Welcome
Welcome — the Shopify for AI agents. Independent merchants publish AI-native storefronts that buyer agents can discover, question and hand off to checkout.

## Backend

The backend is a Supabase Edge Function (`welcome-api`) with Postgres migrations, in `supabase/`. See **[docs/BACKEND.md](docs/BACKEND.md)** for the API contract, deployment steps and demo flow.

```bash
node --test supabase/functions/welcome-api/tests/*.test.ts
```
