# MedSync Backend

Express + TypeScript API with MongoDB persistence.

## First-time setup

1. Copy `.env.example` to `.env`. The backend loads this file relative to its source/build directory, regardless of the launch directory.
2. Set `MONGODB_URI`, `REDIS_URL`, a unique `JWT_ACCESS_SECRET`, `PRESCRIPTION_SIGNING_SECRET`, `CLIENT_URL`, `CLINIC_TIME_ZONE` (defaults to `Asia/Kolkata`), `BREVO_API_KEY` (a Brevo v3 API key, not an SMTP key), `BREVO_SENDER_EMAIL` (a sender verified in Brevo), `RAZORPAY_KEY_ID`, `RAZORPAY_KEY_SECRET`, `RAZORPAY_WEBHOOK_SECRET`, and `ADMIN_NAME`, `ADMIN_EMAIL`, `ADMIN_PHONE`, and a unique `ADMIN_PASSWORD` (at least 8 characters). Use the exact Redis Cloud URL provided by your Redis provider; keep its credentials out of Git. For calls across networks, configure a hospital-operated coturn server with `TURN_URLS` and its `TURN_SHARED_SECRET`; `TURN_CREDENTIAL_TTL_SECONDS` defaults to one hour.
3. Start MongoDB and Redis, then run `npm install`, `npm run redis:test`, `npm run create-admin`, and `npm run dev`. The backend starts its notification worker automatically; `npm run worker` is only for running a standalone worker instead.
4. Start the frontend. The initial administrator can create accounts for the other staff roles.

For BullMQ, configure the Redis provider's `maxmemory-policy` as `noeviction`. Policies such as `volatile-lru` can evict queue data under memory pressure; BullMQ warns when it detects one.

The create-admin script refuses to run once any admin account exists. Do not use the example values or development secrets in production. Keep `PRESCRIPTION_SIGNING_SECRET` stable: rotating it prevents verification of prescriptions signed with the previous key. The prescription HMAC is tamper detection, not a certificate-backed or legally qualified electronic signature. Patient registration sends a six-digit email verification code; Brevo must be configured for registration to complete. Access cookies expire after 15 minutes and are refreshed through a rotating, server-tracked refresh session. Cookie-authenticated requests and Socket.IO connections must identify the browser tab with the `X-MedSync-Tab-ID` header or `tabSessionId` handshake value; this selects that tab's HttpOnly cookies and keeps simultaneous role sessions independent. Appointment checkout requires Razorpay keys; configure the Razorpay webhook URL as `/api/v1/payments/webhook` and subscribe to payment capture/failure events.

## Scripts

- `npm run dev` - start the development server
- `npm run build` - compile TypeScript
- `npm run start` - start the compiled server
- `npm run lint` - run TypeScript validation
- `npm run create-admin` - create the first administrator from environment values
- `npm run redis:test` - verify Redis SET/GET access
- `npm run worker` - start the BullMQ notification worker in watch mode
- `npm run worker:start` - start the compiled worker after `npm run build`
- `npm run queue:test` - enqueue a non-sensitive health-check job; requires `npm run worker` in another terminal

## API

- `GET /api/health`
- `POST /api/v1/auth/register` - public patient registration and verification email
- `POST /api/v1/auth/otp/verify`, `POST /api/v1/auth/otp/resend` - email verification
- `POST /api/v1/auth/login`, `POST /api/v1/auth/refresh`, `POST /api/v1/auth/logout`, `GET /api/v1/auth/me`
- `POST /api/v1/payments/verify` - verify a checkout signature and retrieve payment state from Razorpay
- `POST /api/v1/payments/pharmacy/:orderId/checkout` - create or resume online payment for the signed-in patient's generated pharmacy bill
- `POST /api/v1/payments/webhook` - signature-verified Razorpay payment events
- `GET /api/v1/notifications`, `PATCH /api/v1/notifications/:id/read`, and `PATCH /api/v1/notifications/read-all` - load and manage the signed-in user's persistent notifications
- `GET /api/v1/patients/doctors/:doctorId/slots?date=YYYY-MM-DD` - list available 10-minute slots within the doctor's weekly schedule
- `POST /api/v1/patients/appointments` - reserve an available slot and create a consultation-fee checkout order (requires `Idempotency-Key`)
- `PATCH /api/v1/patients/appointments/:id/reschedule`, `/appointments/:id/cancel`; eligible cancellations at least 24 hours before the slot request a full refund
- `GET /api/v1/patients/departments`, `/doctors`, `/appointments`, `/orders`; `PATCH /api/v1/patients/profile/address`
- `GET /api/v1/doctors/appointments`, `/availability`; `PUT /api/v1/doctors/availability`; appointment status and prescription endpoints
- `GET /api/v1/admin/dashboard`, `/users`, `/audit-logs`; staff and department management endpoints; `POST /api/v1/admin/appointments/:id/refund` handles refund exceptions
- `GET /api/v1/pharmacy/orders`, `/inventory`, `/delivery-staff`; `POST /api/v1/pharmacy/inventory`
- `PATCH /api/v1/pharmacy/inventory/:id`, `/orders/:id/bill`, `/orders/:id/status`, and `/orders/:id/assign`; `POST /api/v1/pharmacy/orders/:id/collect` records pickup without a customer code
- `GET /api/v1/delivery/assignments`; `PATCH /api/v1/delivery/assignments/:id/complete` lets assigned delivery staff mark an order delivered

Authentication uses an HttpOnly, SameSite cookie. The API also supports bearer tokens for non-browser clients.

## Video consultations

The authenticated Socket.IO connection accepts `video:join` with an appointment ID only when the caller is its patient or assigned doctor, the appointment is online and confirmed, its consultation fee is captured, and the scheduled time is within the allowed window (15 minutes before through 60 minutes after). The server limits a call to one patient and one doctor and relays only their WebRTC offer, answer, and ICE candidates. The assigned doctor can emit `video:complete` after the patient has joined; this records completion and unlocks prescription submission. `video:leave` or disconnect notifies the other participant.

Audio/video media connects peer-to-peer when the network allows it, or through the configured TURN relay. Without TURN, some networks cannot establish a direct connection. For broader network compatibility, run coturn under the hospital's control with its shared-secret authentication enabled, then set `TURN_URLS` to its `turn:`/`turns:` address and `TURN_SHARED_SECRET` to the same secret used by coturn. MedSync generates short-lived TURN credentials only after checking appointment access. Do not put the TURN secret in frontend environment variables. Production sites must use HTTPS for browser camera/microphone access.

## Prescriptions and pharmacy

The assigned doctor can submit one prescription per appointment. Online consultations must be finished first. The endpoint requires a confirmed appointment and captured consultation payment; a delivery address is only required when the patient chooses delivery. It records the doctor identity and signs the prescription payload with HMAC-SHA256, creates the pharmacy order, and marks the appointment complete. This signature is tamper detection, not a certificate-backed or legally qualified signature.

The pharmacy verifies the signature and prescription/order item match before checking inventory and generating a bill. The patient initiates Razorpay checkout for their bill; server-side payment verification or a signed Razorpay webhook transitions the order to `PAID`. Stock is deducted once when preparation starts. Pharmacists can mark orders collected without a pickup code, and assigned delivery staff can mark orders delivered without a delivery code. Delivery dispatch requires an address and snapshots it onto the order so later patient profile edits do not change an existing delivery. Refund completion depends on configured Razorpay keys and webhook delivery. Appointment confirmation emails are queued only after payment capture (or doctor confirmation for unpaid requests) and sent to the patient's email by the BullMQ worker. An appointment reservation is not confirmed until its payment succeeds. Notifications are persisted in the signed-in user's notification inbox and refreshed live over Socket.IO. Appointment reminders are queued for five minutes before the scheduled start. Email delivery uses `BREVO_API_KEY` and a verified `BREVO_SENDER_EMAIL`; failed delivery attempts and critical backend errors are logged and surfaced to administrators. Registration OTP email remains synchronous; slot caching and Redis locks are not yet integrated.
