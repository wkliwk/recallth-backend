# PRD: Community Food Database

**Status:** Backlog
**GitHub Issue:** wkliwk/recallth-backend#141
**Last updated:** 2026-04-16

---

## Overview

A crowdsourced HK food nutrition database that improves automatically as users log meals. Nutrition data becomes more accurate over time through aggregation, while each user retains the ability to maintain their own personal food library for dishes they eat from specific restaurants or in personal portions.

**Core problem:** AI estimates for HK local food (茶記菜, 街頭小食, 本地菜) are inaccurate because no single reference database covers them well. The best source of accurate data is the users themselves.

---

## User Stories

1. **As a user logging 楊州炒飯**, I want the nutrition estimate to improve over time as more people log the same dish — so I don't always have to correct inaccurate AI estimates.

2. **As a user who eats from a specific restaurant**, I want to save "XX茶記嘅楊州炒飯" as my personal version with different macros — so my logs reflect what I actually eat, not a generic average.

3. **As any user**, I want to see when a nutrition figure comes from community data vs AI estimate — so I know how much to trust it.

---

## Architecture

### Lookup Chain (priority order)

```
1. Personal library     → user's own saved/edited entries
2. Community HK DB      → aggregated from all users' contributions
3. Open Food Facts      → packaged foods, chain restaurants
4. AI estimate          → fallback, marked as unverified
```

### Two-Tier Data Model

**Layer 1 — Community DB** (`CommunityFoodItem` collection)

| Field | Type | Description |
|---|---|---|
| `name` | String | Canonical food name (normalised, lowercase) |
| `aliases` | String[] | Alternative names / spellings |
| `per100g` | NutrientMap | Aggregated nutrition per 100g |
| `contributionCount` | Number | How many user logs contributed |
| `calorieRange` | { min, max } | Range across contributions |
| `status` | `'unverified' \| 'community' \| 'verified'` | Trust level |
| `lastUpdated` | Date | Last contribution date |

**Layer 2 — Personal Library** (`UserFoodItem` — already exists)
- User-specific overrides, highest priority
- Can be linked to a `CommunityFoodItem` as its base
- User edits propagate only to their own copy

---

## Data Flow

### On food log submission

```
User confirms AI results → Add to log
                        ↓
                  Contribute to Community DB
                  (default: yes, can opt-out per item)
                        ↓
           Community DB aggregates new contribution:
           - Update running average per100g
           - Update calorieRange
           - Increment contributionCount
           - If contributionCount ≥ threshold → status: 'community'
```

### On AI analysis lookup

```
Search query (food name)
        ↓
1. UserFoodItem.findOne({ userId, name: ~query })
        ↓ miss
2. CommunityFoodItem.findOne({ name: ~query, status: 'community'|'verified' })
        ↓ miss
3. offLookup(name, qty, unit)
        ↓ miss
4. AI estimate → { source: 'ai_estimated', estimated: true }
```

---

## Personalisation: Handling Restaurant Variants

**Problem:** XX茶記嘅楊州炒飯 has more meat than the community average.

**Solution: Personal override flow**

1. User logs 楊州炒飯 → community entry used (650 kcal)
2. User taps "Edit" → adjusts calories to 750
3. System prompts: "Save as your personal version of 楊州炒飯?"
4. Saved to `UserFoodItem` linked to `CommunityFoodItem`
5. Next time user logs 楊州炒飯 → personal version auto-suggested

**Future enhancement:** Restaurant tagging
- User can tag an entry with a restaurant name
- System builds per-restaurant variants over time
- If ≥3 users from same restaurant contribute similar data → create restaurant-specific entry

---

## Data Quality

### Contribution trust levels

| Status | Condition | UI label |
|---|---|---|
| `unverified` | First AI estimate, 0–2 contributions | "AI estimate" |
| `community` | 3–9 user contributions, low variance | "Community data" |
| `verified` | 10+ contributions OR manually reviewed | "Verified" |

### Outlier exclusion
- Contributions where calories deviate > 2 standard deviations from running mean are flagged, not included in average
- Flagged contributions still saved for review

### Minimum threshold before replacing AI estimate
- `contributionCount >= 3` AND `stddev < 20%` of mean

---

## Privacy

- Contributions are anonymous — no user identity attached to community entries
- Users can opt out of contributing per-item or globally in settings
- Personal library is always private

---

## Out of Scope (MVP)

- Manual curation / admin review interface
- Restaurant database / geocoded restaurant matching
- User reputation scoring
- Reporting / flagging incorrect community entries

---

## Open Questions

1. **Opt-in vs default contribution?** Default on (with notice) is better for data growth; opt-in is better for privacy. Suggest: default on, easy opt-out in settings.

2. **How to normalise food names?** "楊州炒飯", "揚州炒飯", "Yangzhou Fried Rice" should map to same entry. Need name normalisation (pinyin, traditional/simplified equivalence).

3. **Weight estimation accuracy** — community entries need weight_g per serving to aggregate meaningfully. Should AI always return weight_g?

---

## Dependencies

- `offLookup` service (already built — wkliwk/recallth-backend#140)
- `UserFoodItem` model (already exists)
- New: `CommunityFoodItem` model
- New: contribution aggregation logic on meal log write
