# Recallth Backend

Express 5 + TypeScript + MongoDB API for the Recallth health advisor app.

## Local Development

```bash
# Install dependencies
npm install

# Copy env template and fill in values
cp .env.example .env

# Start dev server (hot reload)
npm run dev
```

## Scripts

| Command | Description |
|---|---|
| `npm run dev` | Start dev server with ts-node-dev (hot reload) |
| `npm run build` | Compile TypeScript to `dist/` |
| `npm start` | Run compiled JS from `dist/index.js` |
| `npm run typecheck` | Run tsc --noEmit (no output files) |

## Deployment

### Railway (Production)

Railway auto-deploys from the `main` branch on every push. Configuration lives in `railway.toml`.

**Manual first-time setup (Railway dashboard):**

1. Go to [railway.app](https://railway.app) and create a new project
2. Select "Deploy from GitHub repo" and connect `wkliwk/recallth-backend`
3. Set the following environment variables in the Railway service settings:

| Variable | Description | Example |
|---|---|---|
| `PORT` | Server port (Railway sets this automatically) | `3001` |
| `NODE_ENV` | Runtime environment | `production` |
| `MONGODB_URI` | MongoDB Atlas connection string | `mongodb+srv://user:pass@cluster.mongodb.net/recallth` |
| `JWT_SECRET` | Secret for signing JWT tokens — min 32 chars, high entropy | — |
| `ANTHROPIC_API_KEY` | Anthropic API key for AI features | `sk-ant-...` |
| `GOOGLE_CLIENT_ID` | Google OAuth client ID for social login | `....apps.googleusercontent.com` |

> Never commit secrets to the repo. Set them only in the Railway dashboard.

4. Railway will detect `railway.toml` and run:
   - Build: `npm run build` (via nixpacks)
   - Start: `npm start`

### Health Check

The `/health` endpoint is configured as Railway's health check target. It must return HTTP 200 for Railway to consider the deployment healthy.

```
GET /health → 200 OK
```

### CORS

In production, `CORS_ORIGIN` should be set to the exact Vercel frontend URL (e.g. `https://recallth.vercel.app`). In development it defaults to `http://localhost:3000`.

## CI

GitHub Actions runs on every push to `main` and on pull requests:
- `npx tsc --noEmit` — fails the build on any TypeScript error
- `npm test` — runs the test suite

Add `TELEGRAM_BOT_TOKEN` and `TELEGRAM_CHAT_ID` to GitHub Actions secrets to enable Telegram notifications on CI pass/fail.
