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

## Deployment (Fly.io)

### One-time setup

1. Install Fly CLI: `curl -L https://fly.io/install.sh | sh`
2. Login: `fly auth login`
3. Create app: `fly apps create recallth-backend`
4. Set secrets (do this once):
   ```
   fly secrets set MONGODB_URI="your-atlas-connection-string"
   fly secrets set JWT_SECRET="your-jwt-secret-min-32-chars"
   fly secrets set GOOGLE_GEMINI_API_KEY="your-gemini-api-key"
   fly secrets set GOOGLE_CLIENT_ID="your-client-id.apps.googleusercontent.com"
   ```
   Get a free Gemini API key at: aistudio.google.com → Get API Key (free tier: 15 RPM, 1M tokens/day)
5. Deploy: `fly deploy`

### MongoDB

Use MongoDB Atlas free tier (M0 cluster at cloud.mongodb.com). Set the connection string as MONGODB_URI secret above.

### Health Check

The `/health` endpoint is used as Fly.io's health check target. It must return HTTP 200 for the deployment to be considered healthy.

```
GET /health → 200 OK
```

### Get your backend URL

After deploy: `fly status` → the URL is `https://recallth-backend.fly.dev`

### Re-deploy after code changes

```
fly deploy
```

### CORS

In production, `CORS_ORIGIN` should be set to the exact Vercel frontend URL (e.g. `https://recallth.vercel.app`). In development it defaults to `http://localhost:3000`.

## CI

GitHub Actions runs on every push to `main` and on pull requests:
- `npx tsc --noEmit` — fails the build on any TypeScript error
- `npm test` — runs the test suite

Add `TELEGRAM_BOT_TOKEN` and `TELEGRAM_CHAT_ID` to GitHub Actions secrets to enable Telegram notifications on CI pass/fail.
