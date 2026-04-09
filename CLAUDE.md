# Recallth Backend

## Tech Stack
- **Runtime:** Node.js + Express + TypeScript
- **Database:** MongoDB (Mongoose ODM)
- **AI:** Anthropic Claude API for health chat
- **Auth:** JWT + bcrypt
- **Deploy:** Railway

## Architecture
```
src/
  routes/          # Express route handlers
  models/          # Mongoose schemas
  services/        # Business logic (AI chat, interaction checker, profile)
  middleware/      # Auth, validation, error handling
  utils/           # Helpers
```

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
