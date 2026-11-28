# Theme Persistence Implementation

## Overview

This implementation provides persistent theme switching across sessions for the TruthBounty API. Authenticated preferences are stored in PostgreSQL and scoped to the authenticated owner. Anonymous preferences are client-scoped only and are never written to shared server storage.

## Features

- ✅ **Theme Toggle**: Switch between light/dark themes
- ✅ **Client-Scoped Anonymous Preferences**: Anonymous callers persist preferences locally
- ✅ **System Preference Fallback**: Respect user's OS theme preference
- ✅ **Owner-Scoped Preferences**: One persisted preference per authenticated user
- ✅ **API Endpoints**: RESTful endpoints for theme management

## Architecture

### Components

1. **ThemeService** (`src/theme.service.ts`)
   - Core business logic for theme management
   - Handles persistence and preference resolution

2. **ThemeController** (`src/theme.controller.ts`)
   - REST API endpoints for theme operations
   - Swagger documentation included

3. **ThemeModule** (`src/theme.module.ts`)
   - NestJS module configuration

4. **UserThemePreference** (`src/theme.entity.ts`)
   - TypeORM entity backed by `user_theme_preferences`

5. **Migration** (`src/migrations/1793200000000-PersistUserThemePreferences.ts`)
   - Creates the owner-scoped table with a database-level theme check constraint

## API Endpoints

### Base URL: `/theme`

### GET /theme
Get current theme preference and resolved theme.

An authenticated request reads the persisted owner-scoped preference. A request without a valid token returns `system` (resolved to `light`) and does not read shared server state.

**Response:**
```json
{
  "theme": "dark",
  "resolved": "dark"
}
```

**Example:**
```bash
curl -H "Authorization: Bearer <access-token>" http://localhost:3000/theme
```

### POST /theme
Set theme preference.

**Request Body:**
```json
{
  "theme": "dark"
}
```

Only `light`, `dark`, and `system` are accepted. The owner is derived from the authenticated principal; any client-supplied user identifier is ignored.

**Response:**
```json
{
  "theme": "dark",
  "userId": "user-123",
  "updatedAt": "2026-03-28T10:30:00.000Z"
}
```

**Example:**
```bash
curl -X POST http://localhost:3000/theme \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer <access-token>" \
  -d '{"theme": "dark"}'
```

### POST /theme/toggle
Toggle between light and dark themes.

**Request Body:**
```json
{
  "currentTheme": "dark"
}
```

`currentTheme` is optional and only used for client-scoped callers; authenticated callers always toggle from the persisted owner preference.

**Response:**
```json
{
  "theme": "light",
  "userId": "user-123",
  "updatedAt": "2026-03-28T10:30:00.000Z"
}
```

### POST /theme/reset
Reset to system preference.

**Response:**
```json
{
  "theme": "system",
  "userId": "user-123",
  "updatedAt": "2026-03-28T10:30:00.000Z"
}
```

### GET /theme/resolved
Get resolved theme (light/dark after system preference resolution). Authenticated requests resolve the persisted owner preference; anonymous requests resolve the client-scoped default.

**Response:**
```json
{
  "theme": "dark"
}
```

### GET /theme/stats
Get theme usage statistics. Counts come only from persisted authenticated preferences; anonymous/client-scoped choices are not counted.

**Response:**
```json
{
  "light": 150,
  "dark": 200,
  "system": 50
}
```

## Theme Types

```typescript
type Theme = 'light' | 'dark' | 'system';

interface ThemePreference {
  theme: Theme;
  userId?: string;
  updatedAt: Date;
}
```

## Implementation Details

### Theme Resolution Priority

1. **Persisted owner preference** (authenticated requests)
   - Read from `user_theme_preferences` using the verified principal only

2. **Client-scoped preference** (anonymous requests)
   - Never read from or written to shared server state
   - Defaults to `system` on the server

3. **System Preference** (fallback)
   - Server resolves `system` to `light`
   - Client uses `prefers-color-scheme` to resolve the actual theme

### Default Behavior

Authenticated users without a stored row receive `system`. No row is created on read. The first supported write creates one row for that owner; subsequent writes update that row in place.

### Storage Strategy

#### Authenticated Users
- One row per owner in `user_theme_preferences`
- Unique owner key prevents duplicates and cross-user reads/writes
- Database CHECK constraint restricts values to `light`, `dark`, `system`

#### Anonymous Users
- Preferences remain in browser localStorage
- API reads return `system` and never create shared server state
- API mutation endpoints require authentication

### System Preference Detection

**Client-side implementation needed:**
```javascript
// Detect system preference
const systemTheme = window.matchMedia('(prefers-color-scheme: dark)').matches
  ? 'dark'
  : 'light';

// Listen for changes
window.matchMedia('(prefers-color-scheme: dark)')
  .addEventListener('change', (e) => {
    const newTheme = e.matches ? 'dark' : 'light';
    // Update theme if user preference is 'system'
  });
```

## Frontend Integration

### React Hook Example

```typescript
import { useState, useEffect } from 'react';

export function useTheme() {
  const [theme, setTheme] = useState<'light' | 'dark'>('light');
  const [preference, setPreference] = useState<Theme>('system');

  // Load theme on mount
  useEffect(() => {
    fetch('/theme')
      .then(res => res.json())
      .then(data => {
        setTheme(data.resolved);
        setPreference(data.theme);
      });
  }, []);

  // Apply theme to document
  useEffect(() => {
    document.documentElement.setAttribute('data-theme', theme);
  }, [theme]);

  const updateTheme = async (newTheme: Theme) => {
    const response = await fetch('/theme', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${getAccessToken()}`,
      },
      body: JSON.stringify({ theme: newTheme }),
    });
    const data = await response.json();
    setTheme(data.theme === 'system' ? getSystemTheme() : data.theme);
    setPreference(data.theme);
  };

  const toggleTheme = async () => {
    const response = await fetch('/theme/toggle', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${getAccessToken()}`,
      },
      body: JSON.stringify({ currentTheme: preference }),
    });
    const data = await response.json();
    setTheme(data.theme);
    setPreference(data.theme);
  };

  return { theme, preference, updateTheme, toggleTheme };
}

function getSystemTheme(): 'light' | 'dark' {
  return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
}

function getAccessToken(): string {
  return localStorage.getItem('accessToken') ?? '';
}
```

### Theme Toggle Component

```tsx
import React from 'react';
import { useTheme } from './useTheme';

export function ThemeToggle() {
  const { theme, toggleTheme } = useTheme();

  return (
    <button
      onClick={toggleTheme}
      aria-label={`Switch to ${theme === 'light' ? 'dark' : 'light'} theme`}
    >
      {theme === 'light' ? '🌙' : '☀️'}
    </button>
  );
}
```

### CSS Variables Example

```css
:root {
  --bg-color: #ffffff;
  --text-color: #000000;
  --border-color: #e0e0e0;
}

[data-theme="dark"] {
  --bg-color: #1a1a1a;
  --text-color: #ffffff;
  --border-color: #333333;
}

body {
  background-color: var(--bg-color);
  color: var(--text-color);
  border-color: var(--border-color);
}
```

## Database Schema

The `user_theme_preferences` table is created by `1793200000000-PersistUserThemePreferences`:

```sql
CREATE TABLE user_theme_preferences (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  "userId" VARCHAR(255) NOT NULL,
  theme VARCHAR(10) NOT NULL CHECK (theme IN ('light', 'dark', 'system')),
  "createdAt" TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  "updatedAt" TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE UNIQUE INDEX "IDX_user_theme_preferences_userId"
  ON user_theme_preferences ("userId");
```

There is no row for anonymous callers and no row for authenticated users who have never chosen a theme.

## Testing

### Unit Tests

`src/theme.service.spec.ts` covers owner-scoped reads/writes, validation, anonymous client-scoped behavior, statistics, and concurrent owner isolation.

### Integration Tests

Authenticated write requests must include a valid access token. Anonymous reads return the `system` default.

## Performance Considerations

- **Database queries**: One read per authenticated fetch; one upsert plus read-back per write
- **Anonymous callers**: No database queries for reads or client-scoped writes
- **System detection**: Client-side only (no server overhead)
- **Caching**: No process-local cache; the persisted row is the source of truth

## Security Considerations

- **Input validation**: Theme values restricted to 'light', 'dark', 'system'
- **User isolation**: Users can only access their own theme preferences
- **No sensitive data**: Theme preferences are not sensitive
- **Rate limiting**: Inherits from global rate limiting

## Browser Support

- **localStorage**: IE 8+, all modern browsers
- **prefers-color-scheme**: Chrome 76+, Firefox 67+, Safari 12.1+
- **CSS custom properties**: IE 11+, all modern browsers

## Future Enhancements

1. **Custom themes** beyond light/dark/system
2. **Theme transitions** and animations
3. **Theme inheritance** for nested components
4. **SSR support** for server-side rendering

## Troubleshooting

### Issue: Authenticated theme not persisting
**Solution:** Confirm the access token is valid and the migration has been applied. Anonymous preferences are client-scoped by design.

### Issue: System preference not detected
**Solution:** Implement client-side system preference detection

### Issue: Theme not applying
**Solution:** Ensure CSS custom properties are properly defined

### Issue: API calls failing
**Solution:** Check network connectivity and API endpoint URLs

## Acceptance Criteria Met ✅

- ✅ **Authenticated persistence**: Owner-scoped row in `user_theme_preferences`
- ✅ **Default behavior**: `system` for users/clients without a stored preference
- ✅ **Anonymous handling**: Client-scoped only; no shared server-side state
- ✅ **Validation**: `light`, `dark`, `system` only, enforced in DTO, service, and database
- ✅ **Stats**: Counts persisted authenticated records only
- ✅ **Concurrency**: Unique owner key with atomic upserts (toggle is a single statement), no process-local source of truth