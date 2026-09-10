/*
 * TallyBridge private Director cue receiver.
 *
 * This module never exposes audio locally and never joins the camera/crew
 * room. It accepts only the exact identity selected by TallyComm's short lease
 * and passes that one remote track to the IFB output graph.
 */
(function () {
  'use strict'

  var state = {
    room: null,
    auth: null,
    connected: false,
    connecting: false,
    activeIdentity: '',
    attachedTrack: null,
    pollTimer: null,
    retryTimer: null,
    stopping: false,
    status: 'idle'
  }

  function byId(id) { return document.getElementById(id) }
  function setStatus(status, text) {
    state.status = status
    var el = byId('ifb-cue-status')
    if (el) el.textContent = text
  }
  function hasConfig() {
    var source = typeof window.getTallyBridgeIfbConfig === 'function' ? window.getTallyBridgeIfbConfig() || {} : {}
    var room = byId('ifb-return-room') || byId('tallyRoom')
    var key = byId('ifb-return-api-key') || byId('tallyApiKey')
    return !!((room ? room.value : source.room) && (key ? key.value : source.apiKey))
  }
  async function api(path) {
    var res = await fetch(path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' })
    var data = await res.json().catch(function () { return {} })
    if (!res.ok) {
      var error = new Error(data.error || 'Cue IFB unavailable')
      error.code = data.error
      throw error
    }
    return data
  }
  function isExpectedPublication(publication, participant) {
    return !!(publication && participant && state.auth && state.activeIdentity &&
      participant.identity === state.activeIdentity &&
      publication.trackName === state.auth.trackName &&
      publication.kind === LivekitClient.Track.Kind.Audio)
  }
  function clearAttachedTrack() {
    if (window.TallyBridgeIfbReturn && typeof window.TallyBridgeIfbReturn.setCueTrack === 'function') {
      window.TallyBridgeIfbReturn.setCueTrack(null)
    }
    state.attachedTrack = null
  }
  function attachTrack(track, publication, participant) {
    if (!isExpectedPublication(publication, participant) || !track || track.kind !== LivekitClient.Track.Kind.Audio) return
    state.attachedTrack = track
    var mixed = false
    if (window.TallyBridgeIfbReturn && typeof window.TallyBridgeIfbReturn.setCueTrack === 'function') {
      mixed = window.TallyBridgeIfbReturn.setCueTrack(track) === true
    }
    setStatus(mixed ? 'active' : 'error', mixed
      ? 'DIRECTOR HABLANDO · AUDIO DE PROGRAMA ATENUADO'
      : 'CUE RECIBIDO · INICIÁ LA RUTA IFB')
  }
  function updateSubscriptions() {
    if (!state.room || !state.auth || !window.LivekitClient) return
    state.room.remoteParticipants.forEach(function (participant) {
      participant.trackPublications.forEach(function (publication) {
        var selected = isExpectedPublication(publication, participant)
        try { publication.setSubscribed(selected) } catch (error) {}
      })
    })
  }
  function applyLease(lease) {
    var nextIdentity = lease && lease.active && typeof lease.identity === 'string' ? lease.identity : ''
    if (nextIdentity === state.activeIdentity) {
      if (!nextIdentity && state.status !== 'ready') setStatus('ready', 'LISTO PARA CUE DEL DIRECTOR')
      return
    }
    state.activeIdentity = nextIdentity
    clearAttachedTrack()
    updateSubscriptions()
    setStatus(nextIdentity ? 'waiting-track' : 'ready', nextIdentity ? 'DIRECTOR CONECTANDO…' : 'LISTO PARA CUE DEL DIRECTOR')
  }
  async function pollLease() {
    if (state.stopping || !state.connected) return
    try {
      var lease = await api('/api/ifb/cue-state')
      applyLease(lease)
    } catch (error) {
      // A missing event/Bridge configuration is not a reason to disturb the
      // active Program-Minus path. Clear any cue source and retry quietly.
      applyLease({ active: false })
      setStatus('error', 'CUE NO DISPONIBLE')
    }
  }
  function startPolling() {
    clearInterval(state.pollTimer)
    state.pollTimer = setInterval(function () { void pollLease() }, 1000)
    void pollLease()
  }
  function scheduleRetry() {
    if (state.retryTimer || state.stopping) return
    state.retryTimer = setTimeout(function () {
      state.retryTimer = null
      void connect()
    }, 5000)
  }
  async function connect() {
    if (state.connected || state.connecting || state.stopping) return
    if (!hasConfig()) { setStatus('idle', 'CONFIGURÁ EL EVENTO PARA CUE'); scheduleRetry(); return }
    if (!window.LivekitClient || !LivekitClient.Room) { setStatus('error', 'MÓDULO CUE NO DISPONIBLE'); return }
    state.connecting = true
    setStatus('connecting', 'CONECTANDO CUE DEL DIRECTOR…')
    try {
      var auth = await api('/api/ifb/cue-token')
      if (!auth || typeof auth.token !== 'string' || typeof auth.livekitUrl !== 'string' ||
          auth.identity !== 'tallybridge-ifb-cue' || auth.trackName !== 'ifb-director-cue') throw new Error('Invalid cue authorization')
      var room = new LivekitClient.Room({ adaptiveStream: false, dynacast: false })
      state.room = room
      state.auth = auth
      room.on(LivekitClient.RoomEvent.TrackPublished, function () { updateSubscriptions() })
      room.on(LivekitClient.RoomEvent.TrackSubscribed, function (track, publication, participant) { attachTrack(track, publication, participant) })
      room.on(LivekitClient.RoomEvent.TrackUnsubscribed, function (track) {
        if (track === state.attachedTrack) { clearAttachedTrack(); setStatus('waiting-track', 'DIRECTOR CONECTANDO…') }
      })
      room.on(LivekitClient.RoomEvent.ParticipantDisconnected, function (participant) {
        if (participant && participant.identity === state.activeIdentity) applyLease({ active: false })
      })
      room.on(LivekitClient.RoomEvent.Disconnected, function () {
        if (room !== state.room) return
        state.room = null; state.auth = null; state.connected = false; state.connecting = false
        clearAttachedTrack()
        if (!state.stopping) { setStatus('error', 'CUE DESCONECTADO'); scheduleRetry() }
      })
      await room.connect(auth.livekitUrl, auth.token, { autoSubscribe: false })
      if (state.stopping || room !== state.room) { try { room.disconnect() } catch (error) {} return }
      state.connected = true; state.connecting = false
      state.activeIdentity = ''
      applyLease(auth.cue || { active: false })
      updateSubscriptions()
      startPolling()
    } catch (error) {
      state.connecting = false
      if (state.room) { try { state.room.disconnect() } catch (ignore) {} }
      state.room = null; state.auth = null
      clearAttachedTrack()
      setStatus('error', 'CUE NO DISPONIBLE')
      scheduleRetry()
    }
  }
  function start() {
    state.stopping = false
    void connect()
  }
  function stop() {
    state.stopping = true
    clearInterval(state.pollTimer); state.pollTimer = null
    clearTimeout(state.retryTimer); state.retryTimer = null
    clearAttachedTrack()
    var room = state.room
    state.room = null; state.auth = null; state.connected = false; state.connecting = false; state.activeIdentity = ''
    if (room) { try { room.disconnect() } catch (error) {} }
  }

  window.addEventListener('beforeunload', stop)
  window.addEventListener('pagehide', stop)
  window.TallyBridgeIfbCue = { start: start, stop: stop, refresh: pollLease }
})()
