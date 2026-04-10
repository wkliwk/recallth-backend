# Recallth — Product Documentation

## Overview

**Recallth** is an AI-powered personal health advisor with persistent memory. Users tell it once about their body, habits, goals, supplements, and medications. From then on, every health question gets a personalised answer based on their complete profile.

**Core problem:** Every time you ask ChatGPT or Google a health question, you have to re-explain your height, weight, supplements, conditions, goals, etc. Recallth remembers everything and gives personalised advice instantly. There are no forms to fill — you just chat, and the AI builds your profile from the conversation.

**Target user:** Health-conscious individuals (20-45) who take supplements, exercise regularly, and want a single trusted source for managing their wellness.

**Positioning:** Your private health consultant with perfect memory.

## Features

### 1. Chat-first Profiling (NO forms)
- **Description:** Users just chat. AI automatically extracts and saves health profile data from natural conversation. No onboarding form — your profile builds itself as you talk.
- **User flow:** Sign up → start chatting ("我185cm 78kg，食緊creatine") → AI responds helpfully AND silently extracts structured data → profile builds over time → user can review/correct extracted data
- **Acceptance criteria:**
  - User can start chatting immediately after signup — no mandatory form
  - AI extracts profile data (height, weight, supplements, etc.) from natural conversation
  - Extracted data shown as subtle notification in chat
  - User can review and correct all auto-extracted data
  - Profile gets richer over time through normal conversations
  - Manual profile editing still available but never required
  - Works in English, Cantonese, and Chinese

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
