# Firestore Security Specification (Phase 0 TDD)

## 1. Data Invariants
- Only `mdnaseerali539@gmail.com` (with `request.auth.token.email_verified == true`) holds permanent `super_admin` authority.
- No other account can create, hold, or escalate to `super_admin` (`role` on new self-signups MUST be `'student'`).
- Students can only read and list their own `users`, `studentEnrollments`, `biometricTemplates`, `attendanceRecords`, `attendanceCorrections`, and `studentAcademicHistory` documents matching `request.auth.uid` or verified `request.auth.token.email.lower()`.
- `attendanceRecords` cannot be updated or deleted by students once created; only the permanent Super Admin can adjust or delete records.
- All timestamps (`createdAt`, `updatedAt`) MUST match `request.time`.
- All path IDs MUST satisfy `^[a-zA-Z0-9_\-]+$` (`<= 128` chars), and all string fields have strict `.size()` bounds.

## 2. Adversarial "Dirty Dozen" Payloads (Must All Return PERMISSION_DENIED)
1. Unauthenticated write to `/users/u1` with `{ role: 'student' }` -> DENIED (`request.auth == null`).
2. Self-registration to `/users/u1` with `{ role: 'super_admin', email: 'attacker@gmail.com' }` -> DENIED (Privilege escalation blocked: self-create forces `role == 'student'`).
3. Self-registration to `/users/u1` with `{ role: 'staff', email: 'attacker@gmail.com' }` -> DENIED (Self-create forces `role == 'student'`).
4. Email spoofing to `/systemCatalog/college` with `email == 'mdnaseerali539@gmail.com'` and `email_verified == false` -> DENIED (`isVerifiedEmail()` required).
5. Student updating own `/users/u1` with `{ role: 'super_admin' }` or `{ status: 'approved' }` -> DENIED (Non-admin cannot change `role` or `status`).
6. Shadow update to `/users/u1` adding extra ghost field `{ isVerifiedAdmin: true }` -> DENIED (`keys().hasOnly(...)` / `affectedKeys().hasOnly(...)`).
7. PII scraping via `list` on `/users` by non-admin without scoping to own UID/email -> DENIED (`allow list` requires `isAdmin()` or own UID/email).
8. Path poisoning write to `/users/../../../admin` or 1KB document ID -> DENIED (`isValidId()` rejects).
9. Student reading another student's `/biometricTemplates/otherId` -> DENIED (`isOwner` / `isAdmin` check fails).
10. Student modifying existing `/attendanceRecords/rec1` (`status: 'present'`) -> DENIED (Updates on attendanceRecords restricted to `isAdmin()`).
11. Client timestamp spoofing (`createdAt: '2020-01-01T00:00:00Z'` instead of `request.time`) -> DENIED (`createdAt == request.time`).
12. Creating `/users/u2` on behalf of another email (`email: 'victim@gmail.com'`) as non-admin -> DENIED (`incoming().email == callerEmail()` enforced).
