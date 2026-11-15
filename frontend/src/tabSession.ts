const tabSessionStorageKey = 'medsync-tab-session-id'
const tabSessionIdPattern = /^[\da-f]{8}-[\da-f]{4}-[1-8][\da-f]{3}-[89ab][\da-f]{3}-[\da-f]{12}$/i
const tabInstanceId = window.crypto.randomUUID()
const channel = typeof BroadcastChannel === 'undefined'
  ? null
  : new BroadcastChannel('medsync-tab-session')

let tabSessionId: string | undefined
let pendingProbe: { id: string; collision: boolean } | undefined
let initialized: Promise<string> | undefined

channel?.addEventListener('message', (event: MessageEvent<{
  type?: string
  id?: string
  tabSessionId?: string
  targetInstanceId?: string
}>) => {
  const message = event.data
  if (
    message.type === 'probe'
    && message.tabSessionId === tabSessionId
    && message.id !== tabInstanceId
  ) {
    channel.postMessage({
      type: 'active',
      id: tabInstanceId,
      targetInstanceId: message.id,
      tabSessionId,
    })
  } else if (
    message.type === 'active'
    && message.targetInstanceId === tabInstanceId
    && pendingProbe
    && message.tabSessionId === pendingProbe.id
  ) {
    pendingProbe.collision = true
  }
})

export const initializeTabSession = () => {
  if (!initialized) {
    initialized = (async () => {
      const storedId = window.sessionStorage.getItem(tabSessionStorageKey)
      tabSessionId = storedId && tabSessionIdPattern.test(storedId)
        ? storedId
        : window.crypto.randomUUID()
      window.sessionStorage.setItem(tabSessionStorageKey, tabSessionId)

      if (channel) {
        pendingProbe = { id: tabSessionId, collision: false }
        for (let attempt = 0; attempt < 4; attempt += 1) {
          channel.postMessage({ type: 'probe', id: tabInstanceId, tabSessionId })
          await new Promise((resolve) => window.setTimeout(resolve, 40))
        }
        if (pendingProbe.collision) {
          tabSessionId = window.crypto.randomUUID()
          window.sessionStorage.setItem(tabSessionStorageKey, tabSessionId)
        }
        pendingProbe = undefined
      }

      return tabSessionId
    })()
  }
  return initialized
}

export const getTabSessionId = () => {
  if (!tabSessionId) {
    throw new Error('The browser-tab session has not been initialized.')
  }
  return tabSessionId
}
