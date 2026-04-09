# Recallth — Product Documentation

## Overview

**Recallth** is an AI-powered personal health advisor with persistent memory. Users tell it once about their body, habits, goals, supplements, and medications. From then on, every health question gets a personalised answer based on their complete profile.

**Core problem:** Every time you ask ChatGPT or Google a health question, you have to re-explain your height, weight, supplements, conditions, goals, etc. Recallth remembers everything and gives personalised advice instantly.

**Target user:** Health-conscious individuals (20-45) who take supplements, exercise regularly, and want a single trusted source for managing their wellness.

**Positioning:** Your private health consultant with perfect memory.

## Features

### 1. Health Profile Onboarding
- **Description:** Guided conversational setup to capture complete health profile
- **User flow:** Sign up → conversational onboarding (body stats, diet, exercise, supplements, medications, sleep, goals) → profile saved. Can be done incrementally.
- **Acceptance criteria:**
  - User can complete onboarding in under 5 minutes
  - Each profile category can be filled independently
  - Profile can be updated at any time
  - All data persists across sessions

### 2. Supplement & Medication Cabinet
- **Description:** Track everything you take — supplements, vitamins, medications, with dosage, timing, and brand
- **User flow:** Add item → enter name, dosage, frequency, timing, brand → saved to cabinet → visible in list
- **Acceptance criteria:**
  - CRUD operations for cabinet items
  - Each item has: name, type (supplement/medication/vitamin), dosage, frequency, timing, brand (optional)
  - Cabinet syncs with Apple HealthKit Medications API (mobile)
  - Web users can manually add items

### 3. Interaction Checker
- **Description:** Automatic conflict detection between supplements and medications
- **User flow:** Add new item to cabinet → system checks against all existing items → flags conflicts with severity level and citations
- **Acceptance criteria:**
  - Checks supplement-supplement interactions
  - Checks supplement-medication interactions
  - Checks medication-medication interactions
  - Shows severity (minor/moderate/major)
  - Provides citations/sources for each interaction
  - Alerts proactively when new item added

### 4. AI Health Chat
- **Description:** Ask any health question — AI answers based on your complete profile
- **User flow:** Type question → AI responds with personalised advice referencing your profile data → conversation saved to history
- **Acceptance criteria:**
  - AI has access to full health profile when answering
  - Responses reference specific user data (e.g., "given your current magnesium intake...")
  - Supports Cantonese/Chinese and English input
  - Conversation history persisted
  - "Not medical advice" disclaimer shown

### 5. History & Tracking
- **Description:** Track what you asked, what was recommended, what changed over time
- **User flow:** View history → see past conversations, profile changes, cabinet changes → timeline view
- **Acceptance criteria:**
  - Chronological list of conversations
  - Profile change log (weight changes, supplement additions/removals)
  - Searchable history

## Out of Scope (MVP)
- Medical diagnosis or treatment prescriptions
- Replacing doctor consultations
- E-commerce / direct product sales
- Social/community features
- Bloodwork/wearable integration (Phase 4)
- Proactive AI insights (Phase 2)
- Meal planning (Phase 3)
