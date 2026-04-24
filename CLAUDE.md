# Recallth Backend

## Git / PR Rules — MANDATORY

**NEVER push directly to main.** Branch protection enforces this — direct pushes will be rejected.

Always follow this flow:
```
git checkout -b feat/issue-NNN-short-description
# ... make changes ...
git push -u origin <branch>
gh pr create --title "..." --body "..."
gh pr merge --auto --squash
```

Create the branch **before** touching any files. Name it `feat/issue-NNN-...` or `fix/issue-NNN-...`.

## Tech Stack
- **Runtime:** Node.js + Express + TypeScript
- **Database:** MongoDB (Mongoose ODM)
- **AI:** Anthropic Claude API for health chat
- **Auth:** JWT + bcrypt
- **Deploy:** fly.io (**NOT Railway** — fully migrated away from Railway)

## Architecture
```
src/
  routes/          # Express route handlers
  models/          # Mongoose schemas
  services/        # Business logic (AI chat, interaction checker, profile)
  middleware/      # Auth, validation, error handling
  utils/           # Helpers
```

## Deployment (fly.io)

**All deploys go through git → PR → merge. Never deploy manually from local.**

The backend is hosted on fly.io. Deployments are triggered automatically on merge to `main` (via CI/CD) or can be triggered manually:

```bash
# One-time setup (if fly CLI not installed)
brew install flyctl
flyctl auth login

# Deploy manually (only if CI is broken — prefer git merge flow)
flyctl deploy --remote-only

# View logs
flyctl logs

# SSH into running instance
flyctl ssh console

# Check app status
flyctl status

# Set/update environment variables
flyctl secrets set KEY=value
flyctl secrets list

# App name (confirm with: flyctl apps list)
# recallth-backend
```

**Environment variables** are managed via `flyctl secrets` — NOT in `.env` files or Railway dashboard.

**Do NOT:**
- Use `railway up` or Railway CLI — Railway is no longer used
- Push directly to main — branch protection is enforced
- Run `flyctl deploy` as a substitute for proper PR flow

## Key Commands
```bash
npm run dev        # Start dev server
npm run build      # TypeScript compile
npm run start      # Production start
npm test           # Run tests
tsc --noEmit       # Type check
```

## Related Repos
- Mobile: wkliwk/recallth-mobile (Expo/React Native)
- Web: wkliwk/recallth-web (Next.js)

## Product Context
AI health advisor with persistent memory. Users onboard once (health profile, supplements, medications, goals) and get personalised advice without repeating themselves. Core API serves both mobile and web clients.

## Key API Domains
- `/auth` — registration, login, JWT
- `/profile` — health profile CRUD (body stats, diet, exercise, sleep, lifestyle, goals)
- `/cabinet` — supplement and medication management
- `/interactions` — conflict checking between supplements and medications
- `/chat` — AI health chat with full profile context
- `/history` — conversation and recommendation history

## Anti-Goals
- No medical diagnosis or prescriptions
- No e-commerce
- No social features
- Keep it simple — no over-engineering
