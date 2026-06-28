# Digital Visiting Card — Firestore Schema

## Overview

**Managers and Advisors** can each have a public digital visiting card with the same layout (company logo header, profile photo, contact actions, product catalog).

Public URLs:

- `https://yoursite.com/card.html?type=advisor&id={advisorDocId}`
- `https://yoursite.com/card.html?type=manager&id={managerDocId}`
- `https://yoursite.com/card.html?slug={cardSlug}` (preferred for sharing)

Company branding (logo, name) is pulled from `company_settings/main`.

---

## Universal card profile fields

These fields exist on **both** `advisors/{id}` and `managers/{id}`:

| Field | Type | Description |
|-------|------|-------------|
| `name` | string | Full name (existing) |
| `mobile` | string | 10-digit mobile (existing) — fallback for Call/WhatsApp |
| **`cardEnabled`** | boolean | Must be `true` for public card to load |
| **`cardSlug`** | string | URL-safe unique slug, e.g. `priya-mehta` |
| **`designation`** | string | Role title — default `Manager` or `Insurance Advisor` |
| **`cardBranch`** | string | Branch / office location shown on card |
| **`email`** | string | Email shown on card |
| **`photoBase64`** | string | Base64 data-URL of profile headshot |
| **`whatsappNumber`** | string | 10-digit number for `tel:` and `wa.me` links |
| **`cardBio`** | string | Optional short introduction |
| `updatedAt` | timestamp | Last profile update |

Subcollection (both roles): `{advisors|managers}/{id}/card_products/{productId}`

---

## Company social links (admin only)

Stored on `company_settings/main` — shown on **all** public visiting cards. Only administrators can edit via **Digital Cards → Digital Card Global Settings**.

| Field | Description |
|-------|-------------|
| **`cardHeaderBannerBase64`** | Cropped full-width header banner (3:1, exported at 1200×400 via Cropper.js) |
| `cardSocialFacebook` | Facebook page URL |
| `cardSocialInstagram` | Instagram profile URL |
| `cardSocialLinkedin` | LinkedIn company/profile URL |
| `cardSocialTwitter` | X (Twitter) profile URL |
| `cardSocialYoutube` | YouTube channel URL |

Managers and advisors see these icons on their cards but cannot change them.

---

## Manager access control (admin)

Each manager document includes an admin-controlled **`feature_enabled`** flag:

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| **`feature_enabled`** | boolean | `false` | Must be `true` for manager/advisor digital card access |
| **`digitalCardEnabled`** | boolean | `false` | Mirror of `feature_enabled` |

### Access rules

| Role | Digital Cards nav | Edit own card | Edit team cards | Public card loads |
|------|-------------------|---------------|-------------------|-------------------|
| Admin | Always | Yes (all) | Yes (all) | Yes if `cardEnabled` |
| Manager | If `feature_enabled === true` | Yes | Yes (their advisors) | Yes if enabled + `cardEnabled` |
| Advisor | If manager's feature on | Yes (own only) | No | Yes if manager enabled + `cardEnabled` |

Public `card.html` verifies feature flags before rendering.

---

## Advisor login (digital card self-service)

Advisors can sign in to manage only their digital card when credentials are set:

| Field | Type | Description |
|-------|------|-------------|
| `username` | string | Login username (unique) |
| `hashedPassword` | string | SHA-256 hash (same as managers) |

Set via **Manage Advisors → Edit** → Digital Card Login section.

On login, the dashboard opens **Digital Cards** with the advisor's profile pre-filled (name, designation, branch, email, phone).

---

## Dashboard — Digital Cards section

1. **Admin:** select any manager or advisor card from dropdown
2. **Manager:** auto-loads own card; can switch to team advisors
3. **Advisor:** auto-loads own card only
4. **Save Card** — persists profile to Firestore
5. **Download vCard** — saves `.vcf` contact file locally
6. **Preview / Copy Link** — share public card URL

---

## WhatsApp inquiry flow

Each product **Inquiry** button opens:

```
https://wa.me/91{whatsappNumber}?text=Hi,%20I%20am%20interested%20in%20{ProductName}...
```

---

## Files

| File | Purpose |
|------|---------|
| `card.html` | Public mobile-responsive visiting card |
| `index.html` | Dashboard `section-digitalcard` + product modal |
| `CARD-SCHEMA.md` | This document |
