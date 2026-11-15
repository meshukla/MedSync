# MedSync

MedSync is a single-hospital management MVP with a React frontend, an Express API, and MongoDB-backed accounts and workflow data.

## Run locally

1. Start MongoDB and configure `backend/.env` from `backend/.env.example`. Set a unique JWT access secret, a Brevo v3 API key (not an SMTP key) and verified sender email, and initial admin details/password. The backend loads this file regardless of its launch directory.
2. From `backend`, run `npm install`, `npm run create-admin`, and `npm run dev`.
3. From `frontend`, run `npm install` and `npm run dev`. Set `VITE_API_BASE_URL` in `frontend/.env` if the API is not at `http://localhost:5000/api/v1`.

The sign-in screen lets users choose Patient, Doctor, Hospital Admin, Pharmacist, or Delivery Boy; the selected role must match the provisioned account. The initial admin provisions staff accounts, which sign in directly without patient registration or OTP. Only patients can self-register, and they must verify their email with a Brevo OTP before signing in. Access tokens and rotating refresh sessions are stored in HttpOnly cookies. Dashboard APIs enforce roles on the server.

The role dashboards have direct URLs at `/patient`, `/doctor`, `/admin`, `/pharmacy`, and `/delivery`. Dashboard changes are pushed through Socket.IO, and views refresh after reconnecting. Each browser tab has its own HttpOnly-cookie session, so different roles can stay signed in simultaneously in the same browser profile. Signing out affects only the current tab. Production web hosting must serve the frontend entry point for these client-side routes.

Patient appointment booking offers calendar dates from today onward, with 10-minute start times throughout the day (00:00 to 23:50) in `CLINIC_TIME_ZONE` (defaults to `Asia/Kolkata`). The API validates the selected clinic-local date and time and rejects slots that are already booked.

## Included workflows

- Role-specific patient, doctor, admin, pharmacy, and delivery dashboards
- MongoDB persistence for users, appointments, pharmacy orders, inventory, and delivery assignments
- Patient email OTP verification and rotating HttpOnly authentication sessions
- Appointment requests with Razorpay checkout, server-side payment verification, and captured-payment confirmation
- Confirmed online appointments with authenticated doctor/patient WebRTC video calls
- Authenticated Socket.IO updates for appointment booking, payment confirmation, and appointment status changes
- Doctors finish online consultations before prescription signing; signing the prescription completes the appointment
- Doctor-authored prescriptions are signed by the API, linked to the appointment, and sent to the pharmacy with patient details
- Patients can save a delivery address; pharmacy orders retain an address snapshot for delivery
- Admin staff account creation/deactivation and dashboard statistics
- Pharmacy staff can add/update medicine inventory, check prescription stock, enter unit prices, and prepare orders for pickup or delivery
- Pharmacy staff can assign dispatch-ready orders to delivery staff; delivery staff see the patient address and can mark the order delivered

Razorpay checkout and server-side payment verification are implemented for consultation fees and pharmacy bills. Pharmacy pickup and delivery completion are recorded by authorized staff without customer codes; patient email verification during registration remains enabled. Prescription signatures use a server HMAC for tamper detection and a doctor identity recorded by the authorized prescription endpoint; this is not a certificate-backed or legally qualified electronic signature. Set and preserve `PRESCRIPTION_SIGNING_SECRET` in production.

For an online appointment, the patient selects **Video consultation** while booking and completes payment. Once confirmed, the patient sees **Join video consultation** and the doctor sees **Start video consultation** on their appointment dashboards. Both must join within 15 minutes before to 60 minutes after the scheduled time. The doctor finishes the call before the prescription form becomes available. Camera/microphone permission is required, and browsers require HTTPS except on localhost.

After a consultation, the doctor submits the prescription from the appointment card. The pharmacy dashboard receives the signed prescription, patient details, and delivery address. Pharmacy staff add any missing medicines to inventory, check stock, and enter unit prices to generate the bill. The patient pays online from the medicine orders panel; confirmed payment updates the pharmacy dashboard in real time. Pharmacy staff then prepare the order and assign it to a delivery person, whose dashboard shows the patient's address. Orders can also be marked ready for pharmacy pickup. Patients can enter or update their address from their dashboard.

Calls use WebRTC between the two participants; MedSync only relays authenticated call signaling and does not use a third-party video host. Media connects directly when possible, or through a hospital-operated TURN server when required. For calls across restrictive networks, configure coturn using `TURN_URLS` and `TURN_SHARED_SECRET` in `backend/.env`; TURN credentials are generated temporarily for authorized participants. Without TURN, some peers will be unreachable.

See [backend/README.md](backend/README.md) for API setup and bootstrap instructions.
