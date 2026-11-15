import { useEffect, useRef, useState } from 'react'
import { io } from 'socket.io-client'
import { getTabSessionId } from './tabSession'

type VideoRole = 'patient' | 'doctor'
type VideoJoined = {
  appointmentId: string
  role: VideoRole
  peerRole?: VideoRole
  iceServers: RTCIceServer[]
}
type VideoSignal = {
  appointmentId: string
  description: RTCSessionDescriptionInit
}
type VideoCandidate = {
  appointmentId: string
  candidate: RTCIceCandidateInit
}

export default function VideoConsultation({ appointmentId, role, serverUrl, onClose }: {
  appointmentId: string
  role: VideoRole
  serverUrl: string
  onClose: () => void
}) {
  const localVideo = useRef<HTMLVideoElement>(null)
  const remoteVideo = useRef<HTMLVideoElement>(null)
  const localStream = useRef<MediaStream | null>(null)
  const peerConnection = useRef<RTCPeerConnection | null>(null)
  const socketConnection = useRef<ReturnType<typeof io> | null>(null)
  const onCloseRef = useRef(onClose)
  const hasConnectedRef = useRef(false)
  const pendingCandidates = useRef<RTCIceCandidateInit[]>([])
  const startedOffer = useRef(false)
  const [status, setStatus] = useState('Preparing camera and microphone...')
  const [error, setError] = useState('')
  const [audioEnabled, setAudioEnabled] = useState(true)
  const [videoEnabled, setVideoEnabled] = useState(true)
  const [hasRemoteVideo, setHasRemoteVideo] = useState(false)
  const [hasConnected, setHasConnected] = useState(false)
  const [finishing, setFinishing] = useState(false)

  useEffect(() => {
    onCloseRef.current = onClose
  }, [onClose])

  useEffect(() => {
    let disposed = false
    const socket = io(serverUrl, {
      withCredentials: true,
      auth: { tabSessionId: getTabSessionId() },
    })
    socketConnection.current = socket

    const drainCandidates = async (connection: RTCPeerConnection) => {
      for (const candidate of pendingCandidates.current) {
        await connection.addIceCandidate(new RTCIceCandidate(candidate))
      }
      pendingCandidates.current = []
    }

    const createOffer = async (connection: RTCPeerConnection) => {
      if (startedOffer.current || connection.signalingState !== 'stable') return
      startedOffer.current = true
      try {
        const offer = await connection.createOffer()
        await connection.setLocalDescription(offer)
        if (connection.localDescription) {
          socket.emit('video:offer', { appointmentId, description: connection.localDescription })
          setStatus('Calling patient...')
        }
      } catch (offerError) {
        setError(offerError instanceof Error ? offerError.message : 'Could not start the video call.')
      }
    }

    socket.on('connect_error', () => {
      if (!disposed) setError('Could not connect to MedSync video. Check your sign-in and try again.')
    })
    socket.on('video:error', (payload: { message?: string }) => {
      if (!disposed) {
        setFinishing(false)
        setError(payload.message || 'Could not join this video consultation.')
        if (hasConnectedRef.current) setStatus('Connected')
      }
    })
    socket.on('video:completed', () => {
      if (!disposed) onCloseRef.current()
    })
    socket.on('video:consultation-completed', () => {
      if (!disposed) onCloseRef.current()
    })
    socket.on('video:joined', (payload: VideoJoined) => {
      if (disposed || payload.appointmentId !== appointmentId || payload.role !== role) return
      const connection = new RTCPeerConnection({ iceServers: payload.iceServers })
      peerConnection.current = connection
      const stream = localStream.current
      if (stream) stream.getTracks().forEach((track) => connection.addTrack(track, stream))
      connection.ontrack = (event) => {
        if (remoteVideo.current && event.streams[0]) remoteVideo.current.srcObject = event.streams[0]
        setHasRemoteVideo(true)
        setHasConnected(true)
        hasConnectedRef.current = true
        setStatus('Connected')
      }
      connection.onicecandidate = (event) => {
        if (event.candidate) {
          socket.emit('video:ice-candidate', { appointmentId, candidate: event.candidate.toJSON() })
        }
      }
      connection.onconnectionstatechange = () => {
        if (connection.connectionState === 'connected') {
          setHasConnected(true)
          hasConnectedRef.current = true
          setStatus('Connected')
        }
        if (connection.connectionState === 'failed') {
          setStatus('Could not establish a network connection. The hospital may need to configure TURN.')
        }
      }
      connection.oniceconnectionstatechange = () => {
        if (connection.iceConnectionState === 'failed') {
          setStatus('Could not establish a network connection. The hospital may need to configure TURN.')
        }
      }

      setError('')
      setStatus(payload.peerRole ? 'Connecting to the other participant...' : 'Waiting for the other participant...')
      if (role === 'doctor' && payload.peerRole === 'patient') void createOffer(connection)
    })
    socket.on('video:participant-joined', (payload: { role?: VideoRole }) => {
      if (disposed) return
      const connection = peerConnection.current
      if (role === 'doctor' && payload.role === 'patient' && connection) void createOffer(connection)
      else setStatus('The other participant joined. Connecting...')
    })
    socket.on('video:participant-left', () => {
      if (disposed) return
      peerConnection.current?.close()
      peerConnection.current = null
      pendingCandidates.current = []
      startedOffer.current = false
      if (remoteVideo.current) remoteVideo.current.srcObject = null
      setHasRemoteVideo(false)
      setStatus('The other participant left. Close and rejoin to continue.')
    })
    socket.on('video:offer', (payload: VideoSignal) => {
      void (async () => {
        const connection = peerConnection.current
        if (disposed || !connection || payload.appointmentId !== appointmentId) return
        try {
          await connection.setRemoteDescription(new RTCSessionDescription(payload.description))
          await drainCandidates(connection)
          const answer = await connection.createAnswer()
          await connection.setLocalDescription(answer)
          if (connection.localDescription) {
            socket.emit('video:answer', { appointmentId, description: connection.localDescription })
            setStatus('Connecting to doctor...')
          }
        } catch (signalError) {
          setError(signalError instanceof Error ? signalError.message : 'Could not accept the video call.')
        }
      })()
    })
    socket.on('video:answer', (payload: VideoSignal) => {
      void (async () => {
        const connection = peerConnection.current
        if (disposed || !connection || payload.appointmentId !== appointmentId) return
        try {
          await connection.setRemoteDescription(new RTCSessionDescription(payload.description))
          await drainCandidates(connection)
          setStatus('Connecting to patient...')
        } catch (signalError) {
          setError(signalError instanceof Error ? signalError.message : 'Could not connect the video call.')
        }
      })()
    })
    socket.on('video:ice-candidate', (payload: VideoCandidate) => {
      void (async () => {
        const connection = peerConnection.current
        if (disposed || !connection || payload.appointmentId !== appointmentId) return
        try {
          if (connection.remoteDescription) {
            await connection.addIceCandidate(new RTCIceCandidate(payload.candidate))
          } else {
            pendingCandidates.current.push(payload.candidate)
          }
        } catch (signalError) {
          setError(signalError instanceof Error ? signalError.message : 'Could not establish the video connection.')
        }
      })()
    })

    const start = async () => {
      if (!navigator.mediaDevices?.getUserMedia) {
        setError('Camera and microphone access requires localhost or a secure HTTPS connection.')
        return
      }
      try {
        const stream = await navigator.mediaDevices.getUserMedia({ audio: true, video: true })
        if (disposed) {
          stream.getTracks().forEach((track) => track.stop())
          return
        }
        localStream.current = stream
        if (localVideo.current) localVideo.current.srcObject = stream
        setStatus('Joining the appointment...')
        socket.emit('video:join', { appointmentId })
      } catch (mediaError) {
        setError(mediaError instanceof Error && mediaError.name === 'NotAllowedError'
          ? 'Allow camera and microphone access in your browser, then try again.'
          : mediaError instanceof Error ? mediaError.message : 'Could not access the camera and microphone.')
      }
    }

    void start()

    return () => {
      disposed = true
      socket.emit('video:leave')
      socket.disconnect()
      socketConnection.current = null
      peerConnection.current?.close()
      localStream.current?.getTracks().forEach((track) => track.stop())
      localStream.current = null
      peerConnection.current = null
    }
  }, [appointmentId, role, serverUrl])

  const toggleAudio = () => {
    const enabled = !audioEnabled
    localStream.current?.getAudioTracks().forEach((track) => { track.enabled = enabled })
    setAudioEnabled(enabled)
  }

  const toggleVideo = () => {
    const enabled = !videoEnabled
    localStream.current?.getVideoTracks().forEach((track) => { track.enabled = enabled })
    setVideoEnabled(enabled)
  }

  const finishConsultation = () => {
    if (!hasConnected || finishing) return
    setFinishing(true)
    setError('')
    setStatus('Completing consultation...')
    socketConnection.current?.emit('video:complete')
  }

  return <div className="video-overlay">
    <section className="video-panel" role="dialog" aria-modal="true" aria-labelledby="video-title">
      <header className="video-header">
        <div><p className="eyebrow">MEDSYNC VIDEO VISIT</p><h2 id="video-title">Online consultation</h2></div>
        <button type="button" className="secondary-btn" onClick={onClose}>Leave without completing</button>
      </header>
      <p className="video-status" role="status">{status}</p>
      {error && <p className="notice" role="alert">{error}</p>}
      <div className="video-grid">
        <div className="video-tile">
          <video ref={remoteVideo} autoPlay playsInline />
          {!hasRemoteVideo && <span className="video-placeholder">{role === 'doctor' ? 'Patient video will appear here' : 'Doctor video will appear here'}</span>}
          <span className="video-name">{role === 'doctor' ? 'Patient' : 'Doctor'}</span>
        </div>
        <div className="video-tile video-self">
          <video ref={localVideo} autoPlay muted playsInline />
          <span className="video-name">You</span>
        </div>
      </div>
      <p className="hint">Audio and video use a direct connection when possible. Otherwise, a hospital-operated TURN server relays the call; MedSync does not use a third-party video host.</p>
      <footer className="video-controls">
        <button type="button" className="secondary-btn" onClick={toggleAudio}>{audioEnabled ? 'Mute microphone' : 'Unmute microphone'}</button>
        <button type="button" className="secondary-btn" onClick={toggleVideo}>{videoEnabled ? 'Turn camera off' : 'Turn camera on'}</button>
        {role === 'doctor'
          ? <button type="button" className="primary-btn video-end-btn" onClick={finishConsultation} disabled={!hasConnected || finishing}>{finishing ? 'Completing...' : 'Finish consultation'}</button>
          : <button type="button" className="primary-btn video-end-btn" onClick={onClose}>Leave consultation</button>}
      </footer>
    </section>
  </div>
}
