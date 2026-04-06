# Authentication & Authorization

## Overview

The PMS backend uses JWT-based authentication with role-based access control (RBAC). There are three roles in the system:

| Role | Value | Description |
|------|-------|-------------|
| Superadmin | `superadmin` | Full system access — manages users, branches, and all settings |
| Admin | `admin` | Manages assigned branches, staff, items, and transactions |
| Branch | `branch` | Operates within a single branch — creates items and transactions |

## Auth Endpoint

### `POST /api/auth/login`

Public endpoint (no token required).

**Request body:**

```json
{
  "email": "user@example.com",
  "password": "secret"
}
```

**Response (once JWT is implemented):**

```json
{
  "statusCode": 200,
  "data": {
    "access_token": "eyJhbGciOi..."
  }
}
```

> **Status:** The login endpoint is scaffolded but JWT token generation is not yet implemented. You will need to:
> 1. Install `@nestjs/jwt` and configure it with the secret from `config/app.config.ts`
> 2. Create a `JwtStrategy` (Passport JWT strategy) to validate tokens
> 3. Register `JwtAuthGuard` as a global guard in `AppModule`

## Guards

### JwtAuthGuard

**Location:** `src/common/guards/jwt-auth.guard.ts`

Extends Passport's `AuthGuard('jwt')`. Applied globally to protect all routes by default. Checks for the `@Public()` decorator — if present, the route is accessible without a token.

### RolesGuard

**Location:** `src/common/guards/roles.guard.ts`

Registered as a global guard in `AppModule`. Reads the `@Roles()` metadata from the handler/class and compares it against `request.user.role`. If no `@Roles()` decorator is present, the route is open to any authenticated user.

**Execution order:** `JwtAuthGuard` (authenticates) -> `RolesGuard` (authorizes)

## Decorators

### `@Roles(...roles: Role[])`

**Location:** `src/common/decorators/roles.decorator.ts`

Restricts a route to one or more roles. Multiple roles act as an OR — the user needs any one of them.

```typescript
@Roles(Role.SUPERADMIN)
@Delete(':id')
remove(@Param('id') id: string) { ... }

@Roles(Role.ADMIN, Role.BRANCH)
@Post()
create(@Body() dto: any) { ... }
```

### `@Public()`

**Location:** `src/common/decorators/public.decorator.ts`

Marks a route as publicly accessible, bypassing `JwtAuthGuard`.

```typescript
@Public()
@Post('login')
login(@Body() loginDto: LoginDto) { ... }
```

## Role Access Matrix

| Module | Superadmin | Admin | Branch |
|----------------|------------|------------|------------|
| Users | Full CRUD | Read | No access |
| Branches | Full CRUD | Read | No access |
| Categories | Full CRUD | Create/Update/Read | Read |
| Items | Full access | Create/Update/Delete | Create/Update |
| Transactions | Full access | Create/Read | Create/Read |
| Reports | All reports | Branch + Transaction | Transaction |
| Dashboard | System-wide | Branch-level | Own branch |

## Configuration

JWT settings are in `src/config/app.config.ts` and read from environment variables:

| Variable | Default | Description |
|---|---|---|
| `JWT_SECRET` | `change-me` | Secret key for signing tokens |
| `JWT_EXPIRES_IN` | `1d` | Token expiration (e.g. `1d`, `12h`, `30m`) |

## TODO

- [ ] Install `@nestjs/jwt` and wire up `JwtModule` in `AuthModule`
- [ ] Create `JwtStrategy` extending `PassportStrategy(Strategy)`
- [ ] Register `JwtAuthGuard` as a global `APP_GUARD`
- [ ] Add password hashing (bcrypt) in `AuthService`
- [ ] Add refresh token support
- [ ] Connect to database for user credential validation
