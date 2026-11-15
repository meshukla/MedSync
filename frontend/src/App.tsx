import { useCallback, useEffect, useRef, useState } from 'react'
import type { FormEvent } from 'react'
import { Navigate, Route, Routes, useNavigate } from 'react-router-dom'
import { io } from 'socket.io-client'
import { getTabSessionId } from './tabSession'
import './App.css'
import VideoConsultation from './VideoConsultation'

type Role = 'patient' | 'doctor' | 'admin' | 'pharmacist' | 'deliveryBoy'
type User = { id: string; name: string; email: string; phone?: string; deliveryAddress?: string; role: Role }
type Doctor = { _id: string; name: string; specialization: string; department: string; fee: number }
type DepartmentRecord = { _id: string; name: string; code: string; description: string }
type AuditEntry = {
  _id: string
  action: string
  entityType: string
  entityId: string
  actorRole: string
  actorId?: { name?: string; role?: string }
  createdAt: string
  details: Record<string, unknown>
}
type WeeklyAvailability = { dayOfWeek: number; startTime: string; endTime: string }
type Checkout = { keyId: string; orderId: string; amount: number; currency: string }
type Appointment = {
  _id: string
  doctorId?: string
  doctorName: string
  department: string
  slot: string
  fee: number
  status: string
  refundStatus?: string
  refundAmountPaise?: number
  paymentStatus?: string
  consultationType?: 'OFFLINE' | 'ONLINE'
  videoConsultationCompletedAt?: string
  checkout?: Checkout
  patientId?: string | { _id?: string; name: string; phone?: string }
}
type Order = {
  _id: string
  patientId: string | { _id: string; name: string; phone: string; deliveryAddress?: string }
  status: string
  total: number
  deliveryAddress?: string
  prescriptionId?: string | {
    doctorName: string
    notes?: string
    digitalSignature: { signedAt: string; signedByName: string; algorithm: string; value: string }
  }
  items: {
    name: string
    quantity: number
    price: number
    dosage?: string
    frequency?: string
    duration?: string
    instructions?: string
  }[]
  stock?: number
}
type InventoryItem = { _id: string; medicine: string; stock: number; lowStock: boolean; lowStockThreshold: number }
type DeliveryStaff = { _id: string; name: string }
type ManagedUser = User & { _id: string; isActive: boolean; createdAt: string }
type UserNotification = {
  _id: string
  event: string
  title: string
  message: string
  createdAt: string
  readAt?: string
}
type NotificationsResponse = { notifications: UserNotification[]; unreadCount: number }
type DashboardData = {
  doctors?: Doctor[]
  appointments?: Appointment[]
  orders?: Order[]
  assignments?: Order[]
  inventory?: InventoryItem[]
  deliveryStaff?: DeliveryStaff[]
  users?: ManagedUser[]
  departments?: DepartmentRecord[]
  auditLogs?: AuditEntry[]
  stats?: Record<string, number>
  notifications?: UserNotification[]
  unreadNotificationCount?: number
}

type RazorpayResult = {
  razorpay_order_id: string
  razorpay_payment_id: string
  razorpay_signature: string
}

type RazorpayFailure = { error?: { description?: string } }
type RazorpayOptions = {
  key: string
  amount: number
  currency: string
  name: string
  description: string
  order_id: string
  handler: (result: RazorpayResult) => void
  modal: { ondismiss: () => void }
}

declare global {
  interface Window {
    Razorpay?: new (options: RazorpayOptions) => {
      open: () => void
      on: (event: 'payment.failed', callback: (response: RazorpayFailure) => void) => void
    }
  }
}

const apiBase = (import.meta.env.VITE_API_BASE_URL || 'http://localhost:5000/api/v1').replace(/\/$/, '')
const apiUrl = (path: string) => `${apiBase}/${path.replace(/^\/+/, '')}`
const apiOrigin = new URL(apiBase, window.location.origin).origin
const clinicTimeZone = import.meta.env.VITE_CLINIC_TIME_ZONE || 'Asia/Kolkata'

const clinicDateValue = (date: Date) => {
  const parts: Record<string, string> = {}
  for (const part of new Intl.DateTimeFormat('en-CA', {
    timeZone: clinicTimeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(date)) {
    if (part.type !== 'literal') parts[part.type] = part.value
  }
  return `${parts.year}-${parts.month}-${parts.day}`
}

const formatClinicDateTime = (value: string) => new Date(value).toLocaleString('en-IN', {
  timeZone: clinicTimeZone,
  dateStyle: 'medium',
  timeStyle: 'short',
})

const formatTimeLabel = (value: string) => {
  const [hour, minute] = value.split(':').map(Number)
  return `${hour % 12 || 12}:${String(minute).padStart(2, '0')} ${hour < 12 ? 'AM' : 'PM'}`
}

let refreshPromise: Promise<boolean> | null = null

class ApiError extends Error {
  readonly data: unknown
  readonly status: number

  constructor(message: string, data: unknown, status: number) {
    super(message)
    this.data = data
    this.status = status
  }
}

function refreshSession(): Promise<boolean> {
  if (!refreshPromise) {
    const tabSessionId = getTabSessionId()
    const request = () => fetch(apiUrl('auth/refresh'), {
      method: 'POST',
      credentials: 'include',
      headers: { 'X-MedSync-Tab-ID': tabSessionId },
    }).then((response) => response.ok)
    const requestWithCrossTabLock = navigator.locks
      ? navigator.locks.request(`medsync-auth-refresh-${tabSessionId}`, request)
      : request()
    refreshPromise = requestWithCrossTabLock.finally(() => {
      refreshPromise = null
    })
  }
  return refreshPromise
}

async function api<T>(path: string, init: RequestInit = {}): Promise<T> {
  const request = async () => {
    try {
      const tabSessionId = getTabSessionId()
      return await fetch(apiUrl(path), {
        ...init,
        credentials: 'include',
        headers: {
          'Content-Type': 'application/json',
          ...init.headers,
          'X-MedSync-Tab-ID': tabSessionId,
        },
      })
    } catch (error) {
      if (error instanceof TypeError) {
        throw new Error(`Could not connect to the MedSync API at ${apiOrigin}. Check that the backend is running, VITE_API_BASE_URL is correct, and the backend allows this site in CLIENT_URL.`)
      }
      throw error
    }
  }
  let response = await request()
  const shouldRefresh = path === 'auth/me' || !path.startsWith('auth/')
  if (response.status === 401 && shouldRefresh && await refreshSession()) {
    response = await request()
  }
  const result = await response.json() as { success?: boolean; message?: string; data?: T }
  if (!response.ok || result.success === false) {
    throw new ApiError(result.message || `Request failed (${response.status}).`, result.data, response.status)
  }
  return result.data as T
}

let razorpayScriptPromise: Promise<void> | null = null

function loadRazorpayCheckout(): Promise<void> {
  if (window.Razorpay) return Promise.resolve()
  if (!razorpayScriptPromise) razorpayScriptPromise = new Promise((resolve, reject) => {
    const script = document.createElement('script')
    script.src = 'https://checkout.razorpay.com/v1/checkout.js'
    script.onload = () => {
      if (window.Razorpay) resolve()
      else reject(new Error('Razorpay checkout did not initialize.'))
    }
    script.onerror = () => reject(new Error('Could not load Razorpay checkout.'))
    document.head.appendChild(script)
  })
  return razorpayScriptPromise
}

function openRazorpayCheckout(checkout: Checkout, description = 'Doctor consultation fee'): Promise<void> {
  return loadRazorpayCheckout().then(() => new Promise((resolve, reject) => {
    if (!window.Razorpay) {
      reject(new Error('Razorpay checkout is unavailable.'))
      return
    }

    const instance = new window.Razorpay({
      key: checkout.keyId,
      amount: checkout.amount,
      currency: checkout.currency,
      name: 'MedSync',
      description,
      order_id: checkout.orderId,
      handler: (result) => {
        void api('payments/verify', { method: 'POST', body: JSON.stringify(result) }).then(() => resolve()).catch(reject)
      },
      modal: { ondismiss: () => reject(new Error('Payment was not completed. Your appointment remains pending.')) },
    })
    instance.on('payment.failed', (response) => reject(new Error(response.error?.description || 'Payment failed. Please try again.')))
    instance.open()
  }))
}

const roleTitles: Record<Role, string> = {
  patient: 'Patient',
  doctor: 'Doctor',
  admin: 'Administrator',
  pharmacist: 'Pharmacist',
  deliveryBoy: 'Delivery',
}

const rolePaths: Record<Role, string> = {
  patient: '/patient',
  doctor: '/doctor',
  admin: '/admin',
  pharmacist: '/pharmacy',
  deliveryBoy: '/delivery',
}

const loginRoles: { role: Role; label: string }[] = [
  { role: 'patient', label: 'Patient' },
  { role: 'doctor', label: 'Doctor' },
  { role: 'admin', label: 'Hospital Admin' },
  { role: 'pharmacist', label: 'Pharmacist' },
  { role: 'deliveryBoy', label: 'Delivery Boy' },
]

const dashboardEndpoints: Record<Role, string[]> = {
  patient: ['patients/doctors', 'patients/appointments', 'patients/orders', 'notifications'],
  doctor: ['doctors/appointments', 'notifications'],
  admin: ['admin/dashboard', 'admin/users', 'admin/audit-logs', 'notifications'],
  pharmacist: ['pharmacy/orders', 'pharmacy/inventory', 'pharmacy/delivery-staff', 'notifications'],
  deliveryBoy: ['delivery/assignments', 'notifications'],
}

function App() {
  const navigate = useNavigate()
  const [user, setUser] = useState<User | null>(null)
  const [loading, setLoading] = useState(true)
  const [data, setData] = useState<DashboardData>({})
  const [message, setMessage] = useState('')
  const [videoAppointment, setVideoAppointment] = useState<Appointment | null>(null)
  const [live, setLive] = useState(false)
  const dashboardRequestId = useRef(0)

  const loadDashboard = useCallback(async (currentUser: User) => {
    const requestId = ++dashboardRequestId.current
    const responses = await Promise.all(dashboardEndpoints[currentUser.role].map((path) => api<unknown>(path)))
    const next: DashboardData = {}
    if (currentUser.role === 'patient') {
      next.doctors = responses[0] as Doctor[]
      next.appointments = responses[1] as Appointment[]
      next.orders = responses[2] as Order[]
      const notifications = responses[3] as NotificationsResponse
      next.notifications = notifications.notifications
      next.unreadNotificationCount = notifications.unreadCount
    } else if (currentUser.role === 'doctor') {
      next.appointments = responses[0] as Appointment[]
      const notifications = responses[1] as NotificationsResponse
      next.notifications = notifications.notifications
      next.unreadNotificationCount = notifications.unreadCount
    } else if (currentUser.role === 'admin') {
      const summary = responses[0] as { stats: Record<string, number>; appointments?: Appointment[]; departments?: DepartmentRecord[] }
      next.stats = summary.stats
      next.appointments = summary.appointments
      next.departments = summary.departments
      next.users = responses[1] as ManagedUser[]
      next.auditLogs = responses[2] as AuditEntry[]
      const notifications = responses[3] as NotificationsResponse
      next.notifications = notifications.notifications
      next.unreadNotificationCount = notifications.unreadCount
    } else if (currentUser.role === 'pharmacist') {
      next.orders = responses[0] as Order[]
      next.inventory = responses[1] as InventoryItem[]
      next.deliveryStaff = responses[2] as DeliveryStaff[]
      const notifications = responses[3] as NotificationsResponse
      next.notifications = notifications.notifications
      next.unreadNotificationCount = notifications.unreadCount
    } else {
      next.assignments = responses[0] as Order[]
      const notifications = responses[1] as NotificationsResponse
      next.notifications = notifications.notifications
      next.unreadNotificationCount = notifications.unreadCount
    }
    if (requestId === dashboardRequestId.current) setData(next)
  }, [])

  useEffect(() => {
    let active = true
    api<User>('auth/me').then(async (profile) => {
      if (!active) return
      setUser(profile)
      await loadDashboard(profile)
    }).catch((error: unknown) => {
      if (active && error instanceof Error && !error.message.includes('Authentication')) setMessage(error.message)
    }).finally(() => {
      if (active) setLoading(false)
    })
    return () => { active = false }
  }, [loadDashboard])

  const refresh = useCallback(async () => {
    if (user) await loadDashboard(user)
  }, [loadDashboard, user])

  const reconcileSession = useCallback(async (actionPending = false) => {
    try {
      const currentUser = await api<User>('auth/me')
      if (currentUser.id === user?.id && currentUser.role === user.role) return false
      await loadDashboard(currentUser)
      setUser(currentUser)
      setMessage(actionPending
        ? `This tab's session changed to ${roleTitles[currentUser.role]}. The action was not completed.`
        : "This tab's session changed. The dashboard has been updated.")
      navigate(rolePaths[currentUser.role], { replace: true })
      return true
    } catch (error) {
      if (error instanceof ApiError && error.status === 401) {
        setUser(null)
        setData({})
        setLive(false)
        setMessage('Your session ended. Sign in again.')
        navigate('/login', { replace: true })
        return true
      }
      throw error
    }
  }, [loadDashboard, navigate, user])

  useEffect(() => {
    if (!user) return
    const socket = io(apiOrigin, {
      withCredentials: true,
      auth: { tabSessionId: getTabSessionId() },
    })
    socket.on('connect', () => {
      setLive(true)
      void loadDashboard(user).catch((error: unknown) => {
        setMessage(error instanceof Error ? error.message : 'Could not refresh dashboard data.')
      })
    })
    socket.on('medsync:event', () => {
      void loadDashboard(user).catch((error: unknown) => {
        setMessage(error instanceof Error ? error.message : 'Could not refresh live dashboard data.')
      })
    })
    socket.on('connect_error', (error) => {
      setLive(false)
      const errorMessage = error.message.toLowerCase()
      if (errorMessage.includes('authentication') || errorMessage.includes('expired')) {
        void api<User>('auth/me').then(async (currentUser) => {
          if (currentUser.id !== user.id || currentUser.role !== user.role) {
            await reconcileSession()
            return
          }
          socket.connect()
        }).catch((sessionError: unknown) => {
          if (sessionError instanceof ApiError && sessionError.status === 401) {
            setUser(null)
            setData({})
            setMessage('Your session ended. Sign in again.')
            navigate('/login', { replace: true })
            return
          }
          setMessage(sessionError instanceof Error
            ? sessionError.message
            : 'Live updates are temporarily unavailable. Dashboard data can still be refreshed.')
        })
      } else {
        setMessage('Live updates are temporarily unavailable. Dashboard data can still be refreshed.')
      }
    })
    socket.on('disconnect', (reason) => {
      setLive(false)
      if (reason === 'io server disconnect') {
        void reconcileSession().catch((error: unknown) => {
          setMessage(error instanceof Error ? error.message : 'Could not verify the current browser session.')
        })
      }
    })
    return () => { socket.disconnect() }
  }, [loadDashboard, navigate, reconcileSession, user])

  useEffect(() => {
    const handleFocus = () => {
      void reconcileSession().catch((error: unknown) => {
        setMessage(error instanceof Error ? error.message : 'Could not verify this tab’s session.')
      })
    }
    window.addEventListener('focus', handleFocus)
    return () => {
      window.removeEventListener('focus', handleFocus)
    }
  }, [reconcileSession])

  const perform = async (action: () => Promise<void>) => {
    setMessage('')
    try {
      if (user && await reconcileSession(true)) return
      await action()
      await refresh()
    } catch (error) {
      if (error instanceof ApiError && error.status === 403 && user) {
        try {
          if (await reconcileSession()) return
        } catch (sessionError) {
          setMessage(sessionError instanceof Error ? sessionError.message : 'Could not verify the current session.')
          return
        }
      }
      setMessage(error instanceof Error ? error.message : 'Something went wrong.')
    }
  }

  const signOut = async () => {
    try {
      await api('auth/logout', { method: 'POST' })
      setUser(null)
      setData({})
      setMessage('')
      setLive(false)
      navigate('/login', { replace: true })
    } catch (error) {
      setMessage(error instanceof Error ? error.message : 'Could not sign out.')
    }
  }

  const markNotificationRead = async (notificationId: string) => {
    try {
      await api(`notifications/${notificationId}/read`, { method: 'PATCH' })
      await refresh()
    } catch (error) {
      setMessage(error instanceof Error ? error.message : 'Could not mark notification as read.')
    }
  }

  const markAllNotificationsRead = async () => {
    try {
      await api('notifications/read-all', { method: 'PATCH' })
      await refresh()
    } catch (error) {
      setMessage(error instanceof Error ? error.message : 'Could not mark notifications as read.')
    }
  }

  if (loading) return <div className="loading-screen">Connecting to MedSync...</div>
  if (!user) return <Routes>
    <Route path="/login" element={<AuthScreen message={message} setMessage={setMessage} onLogin={async (profile) => {
      await loadDashboard(profile)
      setUser(profile)
      setMessage('')
      navigate(rolePaths[profile.role], { replace: true })
    }} />} />
    <Route path="*" element={<Navigate to="/login" replace />} />
  </Routes>

  const dashboard = (
    <div className="app-shell">
      <aside className="sidebar">
        <div className="brand-block">
          <div className="brand-mark">M</div>
          <div><h2>MedSync</h2><small>Hospital System</small></div>
        </div>
        <div className="nav-section">WORKSPACE</div>
        <div className="nav-item active">{roleTitles[user.role]} dashboard</div>
        <div className="sidebar-user">
          <span className="avatar">{user.name.slice(0, 1).toUpperCase()}</span>
          <span><strong>{user.name}</strong><small>{roleTitles[user.role]}</small></span>
        </div>
      </aside>

      <main className="main-panel">
        <header className="topbar">
          <div><p className="eyebrow">{roleTitles[user.role]} workspace</p><h1>Welcome, {user.name.split(' ')[0]}</h1></div>
          <div className="topbar-actions">
            <span className={`live-status${live ? ' connected' : ''}`} role="status">{live ? 'Live updates on' : 'Reconnecting...'}</span>
            <span className="notification-count" aria-label={`${data.unreadNotificationCount || 0} unread notifications`}>
              Notifications {data.unreadNotificationCount || 0}
            </span>
            <button type="button" className="secondary-btn" onClick={() => void signOut()}>Sign out this tab</button>
          </div>
        </header>
        {message && <div className="notice" role="alert">{message}</div>}
        <NotificationPanel
          notifications={data.notifications || []}
          onMarkRead={(id) => void markNotificationRead(id)}
          onMarkAllRead={() => void markAllNotificationsRead()}
        />
        <RoleDashboard user={user} data={data} perform={perform} setMessage={setMessage} onJoinVideo={setVideoAppointment} onForbiddenSession={reconcileSession} />
        {videoAppointment && (user.role === 'patient' || user.role === 'doctor') && <VideoConsultation
          appointmentId={videoAppointment._id}
          role={user.role}
          serverUrl={apiOrigin}
          onClose={() => setVideoAppointment(null)}
        />}
      </main>
    </div>
  )

  return <Routes>
    <Route path="/patient" element={user.role === 'patient' ? dashboard : <Navigate to={rolePaths[user.role]} replace />} />
    <Route path="/doctor" element={user.role === 'doctor' ? dashboard : <Navigate to={rolePaths[user.role]} replace />} />
    <Route path="/admin" element={user.role === 'admin' ? dashboard : <Navigate to={rolePaths[user.role]} replace />} />
    <Route path="/pharmacy" element={user.role === 'pharmacist' ? dashboard : <Navigate to={rolePaths[user.role]} replace />} />
    <Route path="/delivery" element={user.role === 'deliveryBoy' ? dashboard : <Navigate to={rolePaths[user.role]} replace />} />
    <Route path="*" element={<Navigate to={rolePaths[user.role]} replace />} />
  </Routes>
}

function NotificationPanel({ notifications, onMarkRead, onMarkAllRead }: {
  notifications: UserNotification[]
  onMarkRead: (id: string) => void
  onMarkAllRead: () => void
}) {
  return <section className="dashboard-panel notifications-panel" aria-label="Notifications">
    <div className="section-heading">
      <h2>Notifications</h2>
      {notifications.some((item) => !item.readAt) && <button type="button" className="small-btn" onClick={onMarkAllRead}>Mark all read</button>}
    </div>
    {!notifications.length
      ? <p className="empty-state">You’re all caught up.</p>
      : <div className="record-list">{notifications.map((notification) => <article
        className={`record notification-record${notification.readAt ? '' : ' unread'}`}
        key={notification._id}
      >
        <div>
          <strong>{notification.title}</strong>
          <span>{notification.message}</span>
          <small>{new Date(notification.createdAt).toLocaleString()}</small>
        </div>
        {!notification.readAt && <button type="button" className="small-btn" onClick={() => onMarkRead(notification._id)}>Mark read</button>}
      </article>)}</div>}
  </section>
}

function AuthScreen({ message, setMessage, onLogin }: {
  message: string
  setMessage: (message: string) => void
  onLogin: (user: User) => Promise<void>
}) {
  const [selectedRole, setSelectedRole] = useState<Role>('patient')
  const [registering, setRegistering] = useState(false)
  const [verificationEmail, setVerificationEmail] = useState('')
  const [verificationCode, setVerificationCode] = useState('')
  const [busy, setBusy] = useState(false)

  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    setMessage('')
    setBusy(true)
    const form = new FormData(event.currentTarget)
    const values = Object.fromEntries(form.entries())
    try {
      if (verificationEmail) {
        await api('auth/otp/verify', {
          method: 'POST',
          body: JSON.stringify({ email: verificationEmail, code: verificationCode }),
        })
        setVerificationEmail('')
        setVerificationCode('')
        setRegistering(false)
        setMessage('Email verified. You can now sign in.')
      } else if (registering) {
        const result = await api<{ email: string }>('auth/register', { method: 'POST', body: JSON.stringify(values) })
        setVerificationEmail(result.email)
        setVerificationCode('')
        setMessage('Enter the six-digit code sent to your email.')
      } else {
        const result = await api<{ user: User }>('auth/login', {
          method: 'POST',
          body: JSON.stringify({ ...values, role: selectedRole }),
        })
        await onLogin(result.user)
      }
    } catch (error) {
      if (registering && error instanceof ApiError && typeof error.data === 'object' && error.data !== null
        && 'email' in error.data && typeof error.data.email === 'string') {
        setVerificationEmail(error.data.email)
        setVerificationCode('')
        setMessage(error.status === 409
          ? 'This account still needs email verification. Use “Resend verification code” below.'
          : error.message)
      } else if (!registering && !verificationEmail && selectedRole === 'patient'
        && error instanceof ApiError && error.status === 403
        && error.message === 'Verify your email before signing in.'
        && typeof values.email === 'string') {
        setVerificationEmail(values.email)
        setVerificationCode('')
        setMessage('This patient account needs email verification. Use “Resend verification code” below.')
      } else if (error instanceof ApiError && error.status === 403
        && error.message === 'These credentials do not match the selected role.') {
        const roleLabel = loginRoles.find(({ role }) => role === selectedRole)?.label || 'selected'
        setMessage(`This account is not registered as ${roleLabel}. Choose its assigned role or use hospital-provisioned ${roleLabel} credentials.`)
      } else {
        setMessage(error instanceof Error ? error.message : 'Unable to continue.')
      }
    } finally {
      setBusy(false)
    }
  }

  const resendCode = async () => {
    if (!verificationEmail) return
    setBusy(true)
    setMessage('')
    try {
      await api('auth/otp/resend', {
        method: 'POST',
        body: JSON.stringify({ email: verificationEmail }),
      })
      setMessage('If the account needs verification, a code has been sent.')
    } catch (error) {
      setMessage(error instanceof Error ? error.message : 'Unable to resend the code.')
    } finally {
      setBusy(false)
    }
  }

  return (
    <main className="auth-page">
      <section className="auth-card">
        <div className="brand-block auth-brand">
          <div className="brand-mark">M</div><div><h2>MedSync</h2><small>Hospital System</small></div>
        </div>
        <p className="eyebrow">SECURE HEALTHCARE PORTAL</p>
        <h1>{verificationEmail ? 'Verify your email' : registering ? 'Create your patient account' : `Sign in as ${loginRoles.find(({ role }) => role === selectedRole)?.label}`}</h1>
        {!verificationEmail && (
          <div className="role-selector" role="group" aria-label="Select your role">
            {loginRoles.map(({ role, label }) => (
              <button
                key={role}
                className={`role-option${selectedRole === role ? ' selected' : ''}`}
                type="button"
                aria-pressed={selectedRole === role}
                onClick={() => {
                  setSelectedRole(role)
                  setRegistering(false)
                  setMessage('')
                }}
              >
                {label}
              </button>
            ))}
          </div>
        )}
        <p className="auth-copy">{verificationEmail
          ? `Enter the code sent to ${verificationEmail}.`
          : registering
            ? 'Create an account to book appointments and manage your care.'
            : selectedRole === 'patient'
              ? 'Sign in to access your patient account, or register to get started.'
              : 'Staff accounts are created by the hospital. Sign in with your hospital credentials.'}</p>
        {message && <div className="notice" role="alert">{message}</div>}
        <form className="form-stack" onSubmit={(event) => void submit(event)}>
          {verificationEmail ? <>
            <Field
              label="Six-digit verification code"
              name="code"
              autoComplete="off"
              inputMode="numeric"
              minLength={6}
              maxLength={6}
              value={verificationCode}
              onChange={(value) => setVerificationCode(value.replace(/\D/g, '').slice(0, 6))}
              required
            />
          </> : <>
            {registering && <Field label="Full name" name="name" autoComplete="name" required />}
            <Field label="Email address" name="email" type="email" autoComplete="email" required />
            {registering && <>
              <Field label="Phone number" name="phone" type="tel" autoComplete="tel" minLength={10} required />
              <label className="field">Delivery address<textarea name="deliveryAddress" autoComplete="street-address" maxLength={500} placeholder="House, street, area, city, state, postal code" /></label>
              <p className="hint">Add an address now or save one in your dashboard before ordering medicines for delivery.</p>
            </>}
            <Field label="Password" name="password" type="password" autoComplete={registering ? 'new-password' : 'current-password'} minLength={registering ? 8 : undefined} required />
          </>}
          <button className="primary-btn full-width" type="submit" disabled={busy}>{busy ? 'Please wait...' : verificationEmail ? 'Verify email' : registering ? 'Create account' : 'Sign in'}</button>
        </form>
        {verificationEmail
          ? <button className="text-btn" type="button" onClick={() => void resendCode()} disabled={busy}>Resend verification code</button>
          : selectedRole === 'patient' && <button className="text-btn" type="button" onClick={() => { setMessage(''); setRegistering(!registering) }}>
            {registering ? 'Already have an account? Sign in' : 'New patient? Create an account'}
          </button>}
      </section>
    </main>
  )
}

function Field({ label, name, type = 'text', autoComplete, inputMode, minLength, maxLength, value, onChange, required = false }: {
  label: string
  name: string
  type?: string
  autoComplete?: string
  inputMode?: 'numeric' | 'text'
  minLength?: number
  maxLength?: number
  value?: string
  onChange?: (value: string) => void
  required?: boolean
}) {
  return <label className="field">{label}<input name={name} type={type} autoComplete={autoComplete} inputMode={inputMode} minLength={minLength} maxLength={maxLength} value={value} onChange={(event) => onChange?.(event.target.value)} required={required} /></label>
}

function RoleDashboard({ user, data, perform, setMessage, onJoinVideo, onForbiddenSession }: {
  user: User
  data: DashboardData
  perform: (action: () => Promise<void>) => Promise<void>
  setMessage: (message: string) => void
  onJoinVideo: (appointment: Appointment) => void
  onForbiddenSession: () => Promise<boolean>
}) {
  if (user.role === 'patient') return <PatientDashboard user={user} data={data} perform={perform} setMessage={setMessage} onJoinVideo={onJoinVideo} />
  if (user.role === 'doctor') return <DoctorDashboard user={user} data={data} perform={perform} onJoinVideo={onJoinVideo} onForbiddenSession={onForbiddenSession} />
  if (user.role === 'admin') return <AdminDashboard data={data} perform={perform} />
  if (user.role === 'pharmacist') return <PharmacistDashboard data={data} perform={perform} />
  return <DeliveryDashboard data={data} perform={perform} />
}

function PatientDashboard({ user, data, perform, setMessage, onJoinVideo }: {
  user: User
  data: DashboardData
  perform: (action: () => Promise<void>) => Promise<void>
  setMessage: (message: string) => void
  onJoinVideo: (appointment: Appointment) => void
}) {
  const [deliveryAddress, setDeliveryAddress] = useState(user.deliveryAddress || '')
  const [addressSaved, setAddressSaved] = useState(false)
  const [doctorId, setDoctorId] = useState('')
  const [appointmentDate, setAppointmentDate] = useState(() => clinicDateValue(new Date()))
  const [appointmentTime, setAppointmentTime] = useState('')
  const [reschedulingId, setReschedulingId] = useState('')
  const [rescheduleDate, setRescheduleDate] = useState('')
  const [rescheduleTime, setRescheduleTime] = useState('')
  const [rescheduleSlotData, setRescheduleSlotData] = useState<{ key: string; times: string[] } | null>(null)
  const [slotData, setSlotData] = useState<{ key: string; status: 'loaded' | 'error'; times: string[] }>({
    key: '',
    status: 'loaded',
    times: [],
  })
  const [slotRefresh, setSlotRefresh] = useState(0)
  const [consultationType, setConsultationType] = useState<'OFFLINE' | 'ONLINE'>('OFFLINE')
  const doctors = data.doctors || []
  const selectedDoctor = doctors.find((doctor) => doctor._id === doctorId)
  const [minimumDate] = useState(() => clinicDateValue(new Date()))
  const slotKey = doctorId && appointmentDate ? `${doctorId}:${appointmentDate}:${slotRefresh}` : ''
  const currentSlotData = slotData.key === slotKey ? slotData : null
  const availableTimes = currentSlotData?.status === 'loaded' ? currentSlotData.times : []
  const loadingTimes = Boolean(slotKey) && currentSlotData === null
  const activeRescheduleSlotKey = `${reschedulingId}:${rescheduleDate}`
  const rescheduleTimes = rescheduleSlotData?.key === activeRescheduleSlotKey ? rescheduleSlotData.times : []
  const rescheduleLoading = Boolean(reschedulingId && rescheduleDate && rescheduleSlotData?.key !== activeRescheduleSlotKey)

  useEffect(() => {
    let active = true
    if (!doctorId || !appointmentDate) {
      return () => { active = false }
    }

    const key = `${doctorId}:${appointmentDate}:${slotRefresh}`
    void api<string[]>(`patients/doctors/${doctorId}/slots?date=${encodeURIComponent(appointmentDate)}`)
      .then((times) => {
        if (active) setSlotData({ key, status: 'loaded', times })
      })
      .catch((error: unknown) => {
        if (active) {
          setSlotData({ key, status: 'error', times: [] })
          setMessage(error instanceof Error ? error.message : 'Could not load appointment times.')
        }
      })
    return () => { active = false }
  }, [appointmentDate, data.doctors, doctorId, setMessage, slotRefresh])

  useEffect(() => {
    let active = true
    const appointment = (data.appointments || []).find((item) => item._id === reschedulingId)
    if (!appointment?.doctorId || !rescheduleDate) {
      return () => { active = false }
    }
    const key = `${reschedulingId}:${rescheduleDate}`
    void api<string[]>(`patients/doctors/${appointment.doctorId}/slots?date=${encodeURIComponent(rescheduleDate)}`)
      .then((times) => {
        if (active) setRescheduleSlotData({ key, times })
      })
      .catch((error: unknown) => {
        if (active) {
          setRescheduleSlotData({ key, times: [] })
          setMessage(error instanceof Error ? error.message : 'Could not load appointment times.')
        }
      })
    return () => { active = false }
  }, [data.appointments, rescheduleDate, reschedulingId, setMessage])

  const bookAppointment = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    void perform(async () => {
      const result = await api<{ appointment: Appointment; checkout: Checkout }>('patients/appointments', {
        method: 'POST',
        headers: { 'Idempotency-Key': crypto.randomUUID() },
        body: JSON.stringify({ doctorId, date: appointmentDate, time: appointmentTime, consultationType }),
      })
      setAppointmentTime('')
      setSlotRefresh((refreshCount) => refreshCount + 1)
      await openRazorpayCheckout(result.checkout)
    })
  }

  const payForAppointment = (appointment: Appointment) => {
    const checkout = appointment.checkout
    if (!checkout) return
    void perform(() => openRazorpayCheckout(checkout))
  }

  const payForMedicineOrder = (orderId: string) => {
    void perform(async () => {
      const checkout = await api<Checkout>(`payments/pharmacy/${orderId}/checkout`, { method: 'POST' })
      await openRazorpayCheckout(checkout, 'Medicine order payment')
    })
  }

  const saveDeliveryAddress = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    setAddressSaved(false)
    void perform(async () => {
      const result = await api<{ deliveryAddress: string }>('patients/profile/address', {
        method: 'PATCH',
        body: JSON.stringify({ deliveryAddress }),
      })
      setDeliveryAddress(result.deliveryAddress)
      setAddressSaved(true)
    })
  }

  return <>
    <section className="section-heading"><div><p className="eyebrow">YOUR CARE</p><h2>Patient overview</h2></div></section>
    <div className="content-grid">
      <section className="dashboard-panel">
        <h3>Book an appointment</h3>
        {doctors.length === 0 ? <p className="empty-state">No doctors are available yet. Contact the hospital administrator.</p> : (
          <form className="form-stack" onSubmit={bookAppointment}>
            <label className="field">Doctor<select required value={doctorId} onChange={(event) => {
              setDoctorId(event.target.value)
              setAppointmentTime('')
            }}>
              <option value="">Select a doctor</option>
              {doctors.map((doctor) => <option key={doctor._id} value={doctor._id}>{doctor.name} · {doctor.specialization}</option>)}
            </select></label>
            <label className="field">Appointment date<input
              type="date"
              required
              min={minimumDate}
              value={appointmentDate}
              onChange={(event) => {
                setAppointmentDate(event.target.value)
                setAppointmentTime('')
              }}
              disabled={!selectedDoctor}
            /></label>
            <label className="field">Available time (10-minute slots)<select
              required
              value={appointmentTime}
              onChange={(event) => setAppointmentTime(event.target.value)}
              disabled={!selectedDoctor || loadingTimes}
            >
              <option value="">{loadingTimes ? 'Loading times...' : currentSlotData?.status === 'error' ? 'Could not load times' : availableTimes.length ? 'Select a time' : 'No available times'}</option>
              {availableTimes.map((time) => <option key={time} value={time}>{formatTimeLabel(time)}</option>)}
            </select></label>
            <p className="hint">Appointments are available all day, with start times every 10 minutes from 12:00 AM to 11:50 PM.</p>
            <label className="field">Consultation type<select value={consultationType} onChange={(event) => setConsultationType(event.target.value === 'ONLINE' ? 'ONLINE' : 'OFFLINE')}>
              <option value="OFFLINE">Hospital visit</option>
              <option value="ONLINE">Video consultation</option>
            </select></label>
            {selectedDoctor && <p className="hint">{selectedDoctor.department} · ₹{selectedDoctor.fee.toLocaleString()} consultation fee</p>}
            <button type="submit" className="primary-btn" disabled={!appointmentTime || loadingTimes}>Continue to payment</button>
          </form>
        )}
      </section>
      <section className="dashboard-panel">
        <h3>Your appointments</h3>
        <div className="record-list">
          {(data.appointments || []).map((appointment) => <article className="record appointment-record" key={appointment._id}>
            <div className="appointment-summary"><strong>{appointment.doctorName}</strong><span>{appointment.department} · {formatClinicDateTime(appointment.slot)}</span></div>
            <div className="appointment-actions">
              <span className={`status ${appointment.status.toLowerCase()}`}>{appointment.status.replaceAll('_', ' ')}</span>
              {appointment.refundStatus && appointment.refundStatus !== 'NOT_REQUESTED' && <span className="appointment-refund">Refund: {appointment.refundStatus.replaceAll('_', ' ')}</span>}
              {appointment.consultationType === 'ONLINE' && appointment.status === 'CONFIRMED' && !appointment.videoConsultationCompletedAt && <button className="small-btn" onClick={() => onJoinVideo(appointment)}>Join video consultation</button>}
              {appointment.consultationType === 'ONLINE' && appointment.videoConsultationCompletedAt && <span className="appointment-refund">Video consultation completed</span>}
              {appointment.status === 'PAYMENT_PENDING' && appointment.checkout && <button className="small-btn" onClick={() => payForAppointment(appointment)}>Pay ₹{appointment.fee.toLocaleString()}</button>}
              {['PAYMENT_PENDING', 'REQUESTED', 'CONFIRMED'].includes(appointment.status) && <button className="small-btn" onClick={() => {
                const date = clinicDateValue(new Date(appointment.slot))
                setRescheduleDate(date < minimumDate ? minimumDate : date)
                setRescheduleTime('')
                setReschedulingId(reschedulingId === appointment._id ? '' : appointment._id)
              }}>{reschedulingId === appointment._id ? 'Close rescheduling' : 'Reschedule'}</button>}
              {['PAYMENT_PENDING', 'REQUESTED', 'CONFIRMED'].includes(appointment.status) && <button className="small-btn" onClick={() => void perform(async () => {
                await api(`patients/appointments/${appointment._id}/cancel`, { method: 'PATCH' })
              })}>Cancel</button>}
            </div>
            {reschedulingId === appointment._id && <div className="form-stack appointment-reschedule">
              <label className="field">New appointment date<input type="date" min={minimumDate} value={rescheduleDate} onChange={(event) => {
                setRescheduleDate(event.target.value)
                setRescheduleTime('')
              }} /></label>
              <label className="field">Available time<select value={rescheduleTime} onChange={(event) => setRescheduleTime(event.target.value)} disabled={rescheduleLoading}>
                <option value="">{rescheduleLoading ? 'Loading times...' : rescheduleTimes.length ? 'Select a time' : 'No available times'}</option>
                {rescheduleTimes.map((time) => <option key={time} value={time}>{formatTimeLabel(time)}</option>)}
              </select></label>
              <button className="small-btn" disabled={!rescheduleTime || rescheduleLoading} onClick={() => void perform(async () => {
                await api(`patients/appointments/${appointment._id}/reschedule`, {
                  method: 'PATCH',
                  body: JSON.stringify({ date: rescheduleDate, time: rescheduleTime }),
                })
                setReschedulingId('')
                setRescheduleTime('')
                setSlotRefresh((refreshCount) => refreshCount + 1)
              })}>Confirm new time</button>
            </div>}
          </article>)}
          {(data.appointments || []).length === 0 && <p className="empty-state">No appointments yet.</p>}
        </div>
      </section>
      <section className="dashboard-panel full-span">
        <h3>Delivery address</h3>
        <form className="form-stack" onSubmit={saveDeliveryAddress}>
          <label className="field">Address for medicine delivery<textarea
            value={deliveryAddress}
            onChange={(event) => setDeliveryAddress(event.target.value)}
            autoComplete="street-address"
            minLength={8}
            maxLength={500}
            placeholder="House, street, area, city, state, postal code"
            required
          /></label>
          {addressSaved && <p className="success-text">Delivery address saved.</p>}
          <button className="primary-btn" type="submit">Save address</button>
        </form>
      </section>
      <section className="dashboard-panel full-span">
        <h3>Medicine orders</h3>
        <div className="record-list">{(data.orders || []).map((order) => <article className="record" key={order._id}>
          <div>
            <strong>Order {order._id.slice(-6)}</strong>
            <span>{order.items.map((item) => `${item.name} × ${item.quantity}`).join(', ')} · ₹{order.total.toLocaleString()}</span>
          </div>
          <span className={`status ${order.status.toLowerCase()}`}>{order.status.replaceAll('_', ' ')}</span>
          {(order.status === 'BILL_GENERATED' || order.status === 'PAYMENT_PENDING') && <button className="small-btn" onClick={() => payForMedicineOrder(order._id)}>
            {order.status === 'PAYMENT_PENDING' ? 'Continue payment' : 'Pay bill online'} · ₹{order.total.toLocaleString()}
          </button>}
          {order.status === 'PAID' && <span>Payment received. The pharmacy can now prepare your medicines.</span>}
        </article>)}</div>
        {!(data.orders || []).length && <p className="empty-state">No medicine orders yet.</p>}
      </section>
    </div>
  </>
}

function DoctorDashboard({ user, data, perform, onJoinVideo, onForbiddenSession }: { user: User; data: DashboardData; perform: (action: () => Promise<void>) => Promise<void>; onJoinVideo: (appointment: Appointment) => void; onForbiddenSession: () => Promise<boolean> }) {
  const appointments = data.appointments || []
  const [prescriptionAppointment, setPrescriptionAppointment] = useState<Appointment | null>(null)
  return <>
    <section className="section-heading"><div><p className="eyebrow">CLINICAL WORKSPACE</p><h2>Appointments</h2></div><Metric value={String(appointments.length)} label="Total appointments" /></section>
    <DoctorAvailabilityEditor perform={perform} />
    <section className="dashboard-panel">
      <AppointmentList appointments={appointments} perform={perform} onJoinVideo={onJoinVideo} onWritePrescription={setPrescriptionAppointment} />
    </section>
    {prescriptionAppointment && <PrescriptionForm
      appointment={prescriptionAppointment}
      doctorName={user.name}
      onClose={() => setPrescriptionAppointment(null)}
      onForbiddenSession={onForbiddenSession}
    />}
  </>
}

const weekdayNames = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday']

function DoctorAvailabilityEditor({ perform }: { perform: (action: () => Promise<void>) => Promise<void> }) {
  const [availability, setAvailability] = useState<WeeklyAvailability[]>(
    weekdayNames.map((_, dayOfWeek) => ({ dayOfWeek, startTime: '00:00', endTime: '24:00' })),
  )
  const [loaded, setLoaded] = useState(false)
  const [saved, setSaved] = useState(false)

  useEffect(() => {
    let active = true
    void api<WeeklyAvailability[]>('doctors/availability')
      .then((schedule) => {
        if (active) {
          setAvailability(schedule)
          setLoaded(true)
        }
      })
      .catch(() => {
        if (active) setLoaded(true)
      })
    return () => { active = false }
  }, [])

  const updateDay = (dayOfWeek: number, patch: Partial<WeeklyAvailability>) => {
    setAvailability((current) => current.map((entry) => entry.dayOfWeek === dayOfWeek
      ? { ...entry, ...patch }
      : entry))
    setSaved(false)
  }

  return <section className="dashboard-panel">
    <h3>Weekly availability</h3>
    {!loaded ? <p className="hint">Loading your schedule...</p> : <div className="record-list">
      {weekdayNames.map((day, dayOfWeek) => {
        const entry = availability.find((item) => item.dayOfWeek === dayOfWeek)
          || { dayOfWeek, startTime: '00:00', endTime: '00:00' }
        const available = entry.endTime !== entry.startTime
        const allDay = entry.startTime === '00:00' && entry.endTime === '24:00'
        return <div className="record" key={day}>
          <strong>{day}</strong>
          <label className="signature-confirm"><input type="checkbox" checked={available} onChange={(event) => updateDay(dayOfWeek, event.target.checked
            ? { startTime: '09:00', endTime: '18:00' }
            : { startTime: '00:00', endTime: '00:00' })} /> Available</label>
          {available && <>
            <label className="signature-confirm"><input type="checkbox" checked={allDay} onChange={(event) => updateDay(dayOfWeek, event.target.checked
              ? { startTime: '00:00', endTime: '24:00' }
              : { startTime: '09:00', endTime: '18:00' })} /> 24 hours</label>
            {!allDay && <>
              <label className="field">From<input type="time" step={600} value={entry.startTime} onChange={(event) => updateDay(dayOfWeek, { startTime: event.target.value })} /></label>
              <label className="field">Until<input type="time" step={600} value={entry.endTime} onChange={(event) => updateDay(dayOfWeek, { endTime: event.target.value })} /></label>
            </>}
          </>}
        </div>
      })}
    </div>}
    {saved && <p className="success-text">Availability saved.</p>}
    <button className="primary-btn" disabled={!loaded} onClick={() => void perform(async () => {
      await api('doctors/availability', { method: 'PUT', body: JSON.stringify({ weeklyAvailability: availability }) })
      setSaved(true)
    })}>Save availability</button>
    <p className="hint">Appointments use 10-minute start-time intervals within each available window.</p>
  </section>
}

function AppointmentList({ appointments, perform, onJoinVideo, onWritePrescription }: {
  appointments: Appointment[]
  perform: (action: () => Promise<void>) => Promise<void>
  onJoinVideo: (appointment: Appointment) => void
  onWritePrescription: (appointment: Appointment) => void
}) {
  if (!appointments.length) return <p className="empty-state">No appointments scheduled.</p>
  return <div className="record-list">{appointments.map((appointment) => <article className="record" key={appointment._id}>
    <div><strong>{typeof appointment.patientId === 'object' ? appointment.patientId.name : appointment.doctorName}</strong><span>{appointment.department} · {formatClinicDateTime(appointment.slot)}</span></div>
    <span className={`status ${appointment.status.toLowerCase()}`}>{appointment.status.replaceAll('_', ' ')}</span>
    {appointment.consultationType === 'ONLINE' && appointment.status === 'CONFIRMED' && !appointment.videoConsultationCompletedAt && <button className="small-btn" onClick={() => onJoinVideo(appointment)}>Start video consultation</button>}
    {appointment.consultationType === 'ONLINE' && appointment.status === 'CONFIRMED' && !appointment.videoConsultationCompletedAt && <span className="hint">Finish the video call to enable prescription signing.</span>}
    {appointment.status === 'CONFIRMED' && (appointment.consultationType !== 'ONLINE' || appointment.videoConsultationCompletedAt) && <button className="small-btn" onClick={() => onWritePrescription(appointment)}>Write & sign prescription</button>}
    {appointment.status === 'REQUESTED' && <button className="small-btn" onClick={() => void perform(async () => {
      await api(`doctors/appointments/${appointment._id}/status`, { method: 'PATCH', body: JSON.stringify({ status: 'CONFIRMED' }) })
    })}>Confirm</button>}
  </article>)}</div>
}

type PrescriptionItemDraft = {
  name: string
  dosage: string
  frequency: string
  duration: string
  quantity: number
  instructions: string
}

function PrescriptionForm({ appointment, doctorName, onClose, onForbiddenSession }: {
  appointment: Appointment
  doctorName: string
  onClose: () => void
  onForbiddenSession: () => Promise<boolean>
}) {
  const [items, setItems] = useState<PrescriptionItemDraft[]>([{
    name: '',
    dosage: '',
    frequency: '',
    duration: '',
    quantity: 1,
    instructions: '',
  }])
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')

  const updateItem = <K extends keyof PrescriptionItemDraft>(index: number, key: K, value: PrescriptionItemDraft[K]) => {
    setItems((current) => current.map((item, itemIndex) => itemIndex === index ? { ...item, [key]: value } : item))
  }

  const submitPrescription = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    const form = new FormData(event.currentTarget)
    const notes = String(form.get('notes') || '').trim()
    setBusy(true)
    setError('')
    void api(`doctors/appointments/${appointment._id}/prescription`, {
      method: 'POST',
      body: JSON.stringify({
        items: items.map((item) => ({
          ...item,
          name: item.name.trim(),
          dosage: item.dosage.trim(),
          frequency: item.frequency.trim(),
          duration: item.duration.trim(),
          instructions: item.instructions.trim(),
        })),
        ...(notes ? { notes } : {}),
      }),
    }).then(() => {
      onClose()
    }).catch(async (submitError: unknown) => {
      if (submitError instanceof ApiError && submitError.status === 403) {
        try {
          if (await onForbiddenSession()) {
            onClose()
            return
          }
        } catch (sessionError) {
          setError(sessionError instanceof Error ? `Could not verify the current session: ${sessionError.message}` : 'Could not verify the current session.')
          return
        }
      }
      setError(submitError instanceof Error ? submitError.message : 'Could not sign the prescription.')
    }).finally(() => {
      setBusy(false)
    })
  }

  return <div className="video-overlay">
    <section className="video-panel prescription-panel" role="dialog" aria-modal="true" aria-labelledby="prescription-title">
      <header className="video-header">
        <div><p className="eyebrow">POST-CONSULTATION</p><h2 id="prescription-title">Prescription for {typeof appointment.patientId === 'object' ? appointment.patientId.name : 'patient'}</h2></div>
        <button type="button" className="secondary-btn" onClick={onClose}>Close</button>
      </header>
      <p className="hint">Review the prescription after the consultation. Signing sends it directly to the hospital pharmacy and completes this appointment.</p>
      {error && <p className="notice" role="alert">{error}</p>}
      <form className="form-stack" onSubmit={submitPrescription}>
        {items.map((item, index) => <fieldset className="prescription-item" key={index}>
          <legend>Medicine {index + 1}</legend>
          <div className="prescription-fields">
            <label className="field">Medicine name<input value={item.name} onChange={(event) => updateItem(index, 'name', event.target.value)} maxLength={120} required /></label>
            <label className="field">Dosage<input value={item.dosage} onChange={(event) => updateItem(index, 'dosage', event.target.value)} placeholder="e.g. 500 mg" maxLength={120} required /></label>
            <label className="field">Frequency<input value={item.frequency} onChange={(event) => updateItem(index, 'frequency', event.target.value)} placeholder="e.g. twice daily" maxLength={120} required /></label>
            <label className="field">Duration<input value={item.duration} onChange={(event) => updateItem(index, 'duration', event.target.value)} placeholder="e.g. 5 days" maxLength={120} required /></label>
            <label className="field">Quantity<input type="number" min="1" max="1000" value={item.quantity} onChange={(event) => updateItem(index, 'quantity', Number(event.target.value))} required /></label>
            <label className="field">Instructions<input value={item.instructions} onChange={(event) => updateItem(index, 'instructions', event.target.value)} maxLength={1000} /></label>
          </div>
          {items.length > 1 && <button type="button" className="small-btn" onClick={() => setItems((current) => current.filter((_, itemIndex) => itemIndex !== index))}>Remove medicine</button>}
        </fieldset>)}
        <button type="button" className="secondary-btn" onClick={() => setItems((current) => [...current, {
          name: '',
          dosage: '',
          frequency: '',
          duration: '',
          quantity: 1,
          instructions: '',
        }])} disabled={items.length >= 30}>Add medicine</button>
        <label className="field">Notes for pharmacy or patient<textarea name="notes" maxLength={2000} /></label>
        <label className="signature-confirm"><input type="checkbox" required /> I, {doctorName}, confirm these instructions and sign this prescription.</label>
        <p className="hint">MedSync records the authenticated doctor, signature time, and a tamper-evident digital signature.</p>
        <button className="primary-btn" type="submit" disabled={busy}>{busy ? 'Signing...' : 'Sign prescription & send to pharmacy'}</button>
      </form>
    </section>
  </div>
}

function AdminDashboard({ data, perform }: { data: DashboardData; perform: (action: () => Promise<void>) => Promise<void> }) {
  const [role, setRole] = useState<Role>('doctor')
  const [message, setMessage] = useState('')
  const [departmentEdits, setDepartmentEdits] = useState<Record<string, Partial<DepartmentRecord>>>({})
  const createStaff = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    const formElement = event.currentTarget
    setMessage('')
    const form = new FormData(formElement)
    const payload = Object.fromEntries(form.entries())
    payload.role = role
    if (role === 'doctor') {
      payload.fee = Number(payload.fee || 1200).toString()
    } else {
      delete payload.specialization
      delete payload.department
      delete payload.fee
    }
    void perform(async () => {
      await api('admin/users', { method: 'POST', body: JSON.stringify({ ...payload, ...(role === 'doctor' ? { fee: Number(payload.fee) } : {}) }) })
      formElement.reset()
      setMessage('Staff account created.')
    })
  }

  const createDepartment = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    const formElement = event.currentTarget
    const fields = new FormData(formElement)
    void perform(async () => {
      await api('admin/departments', {
        method: 'POST',
        body: JSON.stringify({
          name: String(fields.get('name') || ''),
          code: String(fields.get('code') || ''),
          description: String(fields.get('description') || ''),
        }),
      })
      formElement.reset()
    })
  }

  return <>
    <section className="section-heading"><div><p className="eyebrow">HOSPITAL OPERATIONS</p><h2>Administration</h2></div></section>
    <div className="metric-grid">
      {Object.entries(data.stats || {}).map(([key, value]) => <Metric key={key} value={String(value)} label={key.replace(/([A-Z])/g, ' $1').replace(/^./, (letter) => letter.toUpperCase())} />)}
    </div>
    <section className="content-grid">
      <div className="dashboard-panel">
        <h3>Create staff account</h3>
        {message && <p className="success-text">{message}</p>}
        <form className="form-stack" onSubmit={createStaff}>
          <label className="field">Role<select value={role} onChange={(event) => setRole(event.target.value as Role)}>
            <option value="doctor">Doctor</option><option value="pharmacist">Pharmacist</option><option value="deliveryBoy">Delivery</option><option value="admin">Admin</option>
          </select></label>
          <Field label="Full name" name="name" required />
          <Field label="Email address" name="email" type="email" required />
          <Field label="Phone number" name="phone" type="tel" minLength={10} required />
          <Field label="Temporary password" name="password" type="password" minLength={8} required />
          {role === 'doctor' && <>
            <Field label="Specialization" name="specialization" required />
            <Field label="Department" name="department" required />
            <Field label="Consultation fee (₹)" name="fee" type="number" required />
          </>}
          <button className="primary-btn" type="submit">Create account</button>
        </form>
      </div>
      <div className="dashboard-panel">
        <h3>Accounts</h3>
        <div className="record-list">{(data.users || []).map((account) => <article className="record" key={account._id}>
          <div><strong>{account.name}</strong><span>{account.email} · {roleTitles[account.role]}</span></div>
          <button className="small-btn" onClick={() => void perform(async () => {
            await api(`admin/users/${account._id}/status`, { method: 'PATCH', body: JSON.stringify({ isActive: !account.isActive }) })
          })}>{account.isActive ? 'Disable' : 'Enable'}</button>
        </article>)}</div>
      </div>
    </section>
    <section className="content-grid">
      <div className="dashboard-panel">
        <h3>Departments</h3>
        <form className="form-stack" onSubmit={createDepartment}>
          <Field label="Department name" name="name" required />
          <Field label="Department code" name="code" required />
          <label className="field">Description<textarea name="description" minLength={2} maxLength={500} required /></label>
          <button className="primary-btn" type="submit">Add department</button>
        </form>
        <div className="record-list">{(data.departments || []).map((department) => {
          const edit = departmentEdits[department._id] || {}
          const value = { ...department, ...edit }
          return <article className="record" key={department._id}>
            <label className="field">Name<input value={value.name || ''} onChange={(event) => setDepartmentEdits((current) => ({
              ...current,
              [department._id]: { ...current[department._id], name: event.target.value },
            }))} /></label>
            <label className="field">Code<input value={value.code || ''} onChange={(event) => setDepartmentEdits((current) => ({
              ...current,
              [department._id]: { ...current[department._id], code: event.target.value },
            }))} /></label>
            <label className="field">Description<textarea value={value.description || ''} onChange={(event) => setDepartmentEdits((current) => ({
              ...current,
              [department._id]: { ...current[department._id], description: event.target.value },
            }))} /></label>
            <button className="small-btn" disabled={!Object.keys(edit).length} onClick={() => void perform(async () => {
              await api(`admin/departments/${department._id}`, { method: 'PATCH', body: JSON.stringify(edit) })
              setDepartmentEdits((current) => {
                const next = { ...current }
                delete next[department._id]
                return next
              })
            })}>Save changes</button>
            <button className="small-btn" onClick={() => void perform(async () => {
              await api(`admin/departments/${department._id}`, { method: 'DELETE' })
            })}>Delete</button>
          </article>
        })}</div>
      </div>
      <div className="dashboard-panel">
        <h3>Appointment refunds</h3>
        <div className="record-list">{(data.appointments || []).map((appointment) => <article className="record" key={appointment._id}>
          <div><strong>{appointment.doctorName}</strong><span>{formatClinicDateTime(appointment.slot)} · {appointment.status.replaceAll('_', ' ')}</span></div>
          <span>{appointment.refundStatus ? `Refund: ${appointment.refundStatus.replaceAll('_', ' ')}` : appointment.paymentStatus || 'Payment not captured'}</span>
          {appointment.paymentStatus === 'CAPTURED'
            && !['PENDING', 'PROCESSED'].includes(appointment.refundStatus || '')
            && ['CONFIRMED', 'CANCELLED'].includes(appointment.status)
            && <button className="small-btn" onClick={() => {
              const reason = window.prompt('Reason for this refund exception')
              if (!reason?.trim()) return
              void perform(async () => {
                await api(`admin/appointments/${appointment._id}/refund`, {
                  method: 'POST',
                  body: JSON.stringify({ reason: reason.trim() }),
                })
              })
            }}>Request full refund</button>}
        </article>)}</div>
      </div>
    </section>
    <section className="dashboard-panel">
      <h3>Recent audit log</h3>
      <div className="record-list">{(data.auditLogs || []).map((entry) => <article className="record" key={entry._id}>
        <div><strong>{entry.action.replaceAll('.', ' ')}</strong><span>{entry.actorId?.name || entry.actorRole} · {entry.entityType} {entry.entityId}</span></div>
        <time dateTime={entry.createdAt}>{new Date(entry.createdAt).toLocaleString()}</time>
      </article>)}</div>
      {!(data.auditLogs || []).length && <p className="empty-state">No audit entries recorded yet.</p>}
    </section>
  </>
}

function PharmacistDashboard({ data, perform }: { data: DashboardData; perform: (action: () => Promise<void>) => Promise<void> }) {
  const inventory = data.inventory || []
  const orders = data.orders || []
  const [stockValues, setStockValues] = useState<Record<string, string>>({})
  const [deliveryIds, setDeliveryIds] = useState<Record<string, string>>({})
  const [unitPrices, setUnitPrices] = useState<Record<string, string[]>>({})

  const addInventoryItem = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    const formElement = event.currentTarget
    const fields = new FormData(formElement)
    void perform(async () => {
      await api('pharmacy/inventory', {
        method: 'POST',
        body: JSON.stringify({
          medicine: String(fields.get('medicine') || ''),
          stock: Number(fields.get('stock')),
          lowStockThreshold: Number(fields.get('lowStockThreshold')),
        }),
      })
      formElement.reset()
    })
  }

  return <>
    <section className="section-heading"><div><p className="eyebrow">PHARMACY WORKSPACE</p><h2>Orders & inventory</h2></div><Metric value={String(orders.length)} label="Orders" /></section>
    <section className="dashboard-panel">
      <h3>Prescription orders</h3>
      <div className="record-list">{orders.map((order) => {
        const next: Record<string, string> = {
          PAID: 'PREPARING',
          READY_FOR_PICKUP: 'COLLECTED',
        }
        const prices = unitPrices[order._id] || order.items.map((item) => item.price > 0 ? String(item.price) : '')
        const prescription = typeof order.prescriptionId === 'object' ? order.prescriptionId : null
        const patient = typeof order.patientId === 'object' ? order.patientId : null
        return <article className="record" key={order._id}>
          <div className="pharmacy-order-info">
            <strong>{patient?.name || `Order ${order._id.slice(-6)}`}</strong>
            <span>{patient?.phone || 'Patient phone unavailable'} · {order.deliveryAddress || patient?.deliveryAddress || 'Delivery address missing'}</span>
            <span>{order.items.map((item) => `${item.name} × ${item.quantity}${item.dosage ? ` · ${item.dosage}` : ''}${item.frequency ? ` · ${item.frequency}` : ''}${item.duration ? ` · ${item.duration}` : ''}`).join(', ')} · ₹{order.total}</span>
            {prescription && <span>Digitally signed by {prescription.digitalSignature.signedByName} · {formatClinicDateTime(prescription.digitalSignature.signedAt)}</span>}
            {prescription?.notes && <span>Prescription notes: {prescription.notes}</span>}
          </div>
          <span className={`status ${order.status.toLowerCase()}`}>{order.status.replaceAll('_', ' ')}</span>
          {order.status === 'PRESCRIPTION_RECEIVED' && <div className="bill-editor">
            {order.items.map((item, index) => <label className="field" key={`${item.name}-${index}`}>
              {item.name} · unit price (₹)
              <input
                type="number"
                min="0.01"
                step="0.01"
                value={prices[index] || ''}
                onChange={(event) => setUnitPrices((current) => ({
                  ...current,
                  [order._id]: prices.map((price, priceIndex) => priceIndex === index ? event.target.value : price),
                }))}
                required
              />
            </label>)}
            <button className="small-btn" onClick={() => void perform(async () => {
              await api(`pharmacy/orders/${order._id}/bill`, {
                method: 'PATCH',
                body: JSON.stringify({ unitPrices: prices.map(Number) }),
              })
            })}>Check stock & generate bill</button>
          </div>}
          {order.status === 'PREPARING' && <>
            <button className="small-btn" onClick={() => void perform(async () => {
              await api(`pharmacy/orders/${order._id}/status`, { method: 'PATCH', body: JSON.stringify({ status: 'READY_FOR_PICKUP' }) })
            })}>Ready for pharmacy pickup</button>
            <button className="small-btn" onClick={() => void perform(async () => {
              await api(`pharmacy/orders/${order._id}/status`, { method: 'PATCH', body: JSON.stringify({ status: 'READY_FOR_DISPATCH' }) })
            })}>Ready for delivery</button>
          </>}
          {next[order.status] && <button className="small-btn" onClick={() => void perform(async () => {
            await api(`pharmacy/orders/${order._id}/status`, { method: 'PATCH', body: JSON.stringify({ status: next[order.status] }) })
          })}>{next[order.status].replaceAll('_', ' ')}</button>}
          {order.status === 'READY_FOR_PICKUP' && <button className="small-btn" onClick={() => void perform(async () => {
            await api(`pharmacy/orders/${order._id}/collect`, { method: 'POST' })
          })}>Mark collected</button>}
          {order.status === 'READY_FOR_DISPATCH' && <div className="assign-controls">
            <select aria-label="Assign delivery staff" value={deliveryIds[order._id] || ''} onChange={(event) => setDeliveryIds({ ...deliveryIds, [order._id]: event.target.value })}>
              <option value="">Select delivery staff</option>
              {(data.deliveryStaff || []).map((staff) => <option key={staff._id} value={staff._id}>{staff.name}</option>)}
            </select>
            <button className="small-btn" disabled={!deliveryIds[order._id]} onClick={() => void perform(async () => {
              await api(`pharmacy/orders/${order._id}/assign`, { method: 'PATCH', body: JSON.stringify({ deliveryUserId: deliveryIds[order._id] }) })
            })}>Assign</button>
          </div>}
        </article>
      })}</div>
      {!orders.length && <p className="empty-state">No prescription orders are waiting.</p>}
    </section>
    <section className="dashboard-panel inventory-panel">
      <h3>Medicine inventory</h3>
      <form className="form-inline inventory-add" onSubmit={addInventoryItem}>
        <Field label="Medicine name" name="medicine" required />
        <label className="field">Opening stock<input name="stock" type="number" min="0" required /></label>
        <label className="field">Low-stock threshold<input name="lowStockThreshold" type="number" min="0" defaultValue="10" required /></label>
        <button className="primary-btn" type="submit">Add medicine</button>
      </form>
      <div className="inventory-list">{inventory.map((item) => <div className="inventory-row" key={item._id}>
        <div><strong>{item.medicine}</strong><small className={item.lowStock ? 'low-stock' : ''}>{item.lowStock ? 'Low stock' : 'In stock'} · Reorder at {item.lowStockThreshold}</small></div>
        <input aria-label={`${item.medicine} stock`} type="number" min="0" value={stockValues[item._id] ?? item.stock} onChange={(event) => setStockValues({ ...stockValues, [item._id]: event.target.value })} />
        <button className="small-btn" onClick={() => void perform(async () => {
          await api(`pharmacy/inventory/${item._id}`, { method: 'PATCH', body: JSON.stringify({ stock: Number(stockValues[item._id] ?? item.stock) }) })
          setStockValues((values) => { const next = { ...values }; delete next[item._id]; return next })
        })}>Save</button>
      </div>)}</div>
    </section>
  </>
}

function DeliveryDashboard({ data, perform }: { data: DashboardData; perform: (action: () => Promise<void>) => Promise<void> }) {
  const assignments = data.assignments || []
  return <>
    <section className="section-heading"><div><p className="eyebrow">DELIVERY WORKSPACE</p><h2>Assigned deliveries</h2></div><Metric value={String(assignments.filter((order) => order.status === 'OUT_FOR_DELIVERY').length)} label="In progress" /></section>
    <section className="dashboard-panel">
      <div className="record-list">{assignments.map((order) => {
        const patient = typeof order.patientId === 'string' ? null : order.patientId
        return <article className="record" key={order._id}>
          <div><strong>{patient?.name || `Order ${order._id.slice(-6)}`}</strong><span>{patient?.phone || 'Patient details unavailable'}</span><span>Delivery address: {order.deliveryAddress || patient?.deliveryAddress || 'Address unavailable'}</span></div>
          <span className={`status ${order.status.toLowerCase()}`}>{order.status.replaceAll('_', ' ')}</span>
          {order.status === 'OUT_FOR_DELIVERY' && <button className="small-btn" onClick={() => void perform(async () => {
            await api(`delivery/assignments/${order._id}/complete`, { method: 'PATCH' })
          })}>Mark delivered</button>}
        </article>
      })}</div>
      {!assignments.length && <p className="empty-state">No deliveries are assigned to you.</p>}
    </section>
  </>
}

function Metric({ value, label }: { value: string; label: string }) {
  return <div className="metric-card"><span>{label}</span><strong>{value}</strong></div>
}

export default App
