/*
 * TallyBridge IFB return publisher.
 *
 * This deliberately lives in the Bridge renderer: only that renderer can open
 * the operator-selected console input. It does not retain an input device,
 * never starts automatically, and connects exclusively to the isolated IFB
 * room minted by TallyComm. The regular camera / crew intercom room is never
 * used here.
 */
(function () {
  'use strict'

  var state = {
    room: null,
    track: null,
    audioCtx: null,
    analyser: null,
    source: null,
    meterSink: null,
    meterFrame: 0,
    // The console output is commonly a line-level feed arriving below the
    // browser microphone nominal level. Keep the gain stage in Bridge, where
    // production can meter it, instead of making Talent compensate locally.
    captureStream: null,
    captureSource: null,
    captureGain: null,
    captureLimiter: null,
    captureDestination: null,
    captureTrack: null,
    inputListPending: false,
    inputAccessAttempted: false,
    inputAccessError: null,
    running: false,
    starting: false,
    refreshing: false,
    stopping: false,
    deviceId: '',
    deviceLabel: '',
    status: 'idle',
    statusText: '',
    auth: null
  }

  function tr(key, fallback) {
    return typeof window.TallyBridgeText === 'function'
      ? window.TallyBridgeText(key) || fallback
      : fallback
  }

  function byId(id) { return document.getElementById(id) }

  function currentConfig() {
    var source = typeof window.getTallyBridgeIfbConfig === 'function'
      ? (window.getTallyBridgeIfbConfig() || {})
      : {}
    var roomEl = byId('ifb-return-room')
    var apiKeyEl = byId('ifb-return-api-key')
    return {
      room: String(roomEl ? roomEl.value : (source.room || '')).trim(),
      apiKey: String(apiKeyEl ? apiKeyEl.value : (source.apiKey || '')).trim()
    }
  }

  function configReady(config) {
    return !!(config && config.room && config.apiKey)
  }

  function rememberConfig(config) {
    if (typeof window.updateTallyBridgeIfbConfig === 'function') {
      window.updateTallyBridgeIfbConfig(config)
    }
  }

  function persistConfig(config) {
    rememberConfig(config)
    if (typeof window.persistTallyBridgeIfbConfig === 'function') {
      return window.persistTallyBridgeIfbConfig(config)
    }
    return Promise.resolve({ ok: false })
  }

  function statusText() {
    if (state.statusText) return state.statusText
    return tr('ifbReturnReady', 'LISTO PARA INICIAR EL RETORNO')
  }

  function escapeHtml(value) {
    return String(value == null ? '' : value)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;')
  }

  function cardHtml() {
    var active = state.running
    var config = currentConfig()
    return [
      '<section class="ifb-return optional" id="ifb-return-card" aria-labelledby="ifb-return-title">',
      '  <div class="ifb-return-head">',
      '    <div>',
      '      <div class="ifb-return-kicker">IFB RETURN · PROGRAM-MINUS <span class="ifb-return-extra">' + escapeHtml(tr('ifbReturnOptional', 'OPCIONAL')) + '</span></div>',
      '      <div class="ifb-return-title" id="ifb-return-title">' + escapeHtml(tr('ifbReturnTitle', 'RETORNO PARA TALENT')) + '</div>',
      '    </div>',
      '    <div class="ifb-return-chip ' + (active ? 'active' : state.status === 'error' ? 'error' : '') + '" id="ifb-return-chip">' +
            (active ? escapeHtml(tr('ifbReturnOnAir', 'AL AIRE')) : escapeHtml(tr('ifbReturnOff', 'APAGADO'))) + '</div>',
      '  </div>',
      '  <p class="ifb-return-note">' + escapeHtml(tr('ifbReturnNote', 'Publica la mezcla Program-Minus seleccionada únicamente a los talentos autorizados. No abre el intercom de cámaras ni crew.')) + '</p>',
      '  <p class="ifb-return-note">' + escapeHtml(tr('ifbReturnIndependent', 'Es independiente del tally del switcher. Configuralo aquí y activalo aunque no haya un switcher conectado.')) + '</p>',
      '  <p class="ifb-return-note">' + escapeHtml(tr('ifbReturnGain', 'Applies a +12 dB recovery trim with a soft limiter before publishing.')) + '</p>',
      '  <div class="ifb-return-config">',
      '    <label class="field"><span class="field-label">' + escapeHtml(tr('ifbReturnRoom', 'SALA TALLYCOMM')) + '</span>',
      '      <input class="input" type="text" id="ifb-return-room" value="' + escapeHtml(config.room) + '" placeholder="SHOW26" autocorrect="off" autocapitalize="off" spellcheck="false">',
      '      <span class="field-hint">' + escapeHtml(tr('ifbReturnRoomHint', 'Código del evento con miembros Talent')) + '</span>',
      '    </label>',
      '    <label class="field"><span class="field-label">' + escapeHtml(tr('ifbReturnApiKey', 'API KEY DEL EVENTO')) + '</span>',
      '      <input class="input" type="password" id="ifb-return-api-key" value="' + escapeHtml(config.apiKey) + '" placeholder="Desde el dashboard del evento" autocorrect="off" autocapitalize="off" spellcheck="false">',
      '      <span class="field-hint">' + escapeHtml(tr('ifbReturnApiKeyHint', 'Desde el dashboard del evento · SWITCHER API KEY')) + '</span>',
      '    </label>',
      '  </div>',
      '  <div class="ifb-return-controls">',
      '    <label class="field"><span class="field-label">' + escapeHtml(tr('ifbReturnInput', 'ENTRADA DE CONSOLA')) + '</span>',
      '      <select class="input" id="ifb-return-device" ' + (active || state.starting ? 'disabled' : '') + '>' +
                (active ? '<option value="' + escapeHtml(state.deviceId) + '">' + escapeHtml(state.deviceLabel || tr('ifbReturnSelectedInput', 'Entrada seleccionada')) + '</option>' : '') +
              '</select>',
      '      <button class="ifb-return-input-refresh" id="ifb-return-input-refresh" type="button" ' + (active || state.starting ? 'disabled' : '') + '>' + escapeHtml(tr('ifbReturnRefreshInputs', 'ACTUALIZAR ENTRADAS')) + '</button>',
      '    </label>',
      '    <div class="ifb-return-meter-wrap">',
      '      <div class="ifb-return-meter" aria-label="' + escapeHtml(tr('ifbReturnLevel', 'Nivel de entrada')) + '"><div class="ifb-return-meter-fill" id="ifb-return-meter-fill"></div></div>',
      '      <div class="ifb-return-meter-label"><span>' + escapeHtml(tr('ifbReturnLevel', 'NIVEL DE ENTRADA')) + '</span><strong id="ifb-return-meter-value">0%</strong></div>',
      '    </div>',
      '    <div class="ifb-return-actions">',
      '      <button class="ifb-return-start" id="ifb-return-start" type="button" ' + (active || state.starting ? 'disabled' : '') + '>' + escapeHtml(state.starting ? tr('ifbReturnStarting', 'PREPARANDO…') : tr('ifbReturnStart', 'INICIAR RETORNO')) + '</button>',
      '      <button class="ifb-return-refresh" id="ifb-return-refresh" type="button" ' + (!active || state.refreshing ? 'disabled' : '') + '>' + escapeHtml(state.refreshing ? tr('ifbReturnRefreshing', 'ACTUALIZANDO…') : tr('ifbReturnRefresh', 'ACTUALIZAR TALENTS')) + '</button>',
      '      <button class="ifb-return-stop" id="ifb-return-stop" type="button" ' + (!active ? 'disabled' : '') + '>' + escapeHtml(tr('ifbReturnStop', 'DETENER')) + '</button>',
      '    </div>',
      '  </div>',
      '  <div class="ifb-return-state ' + escapeHtml(state.status) + '" id="ifb-return-state">' + escapeHtml(statusText()) + '</div>',
      '</section>'
    ].join('')
  }

  function renderStatus() {
    var el = byId('ifb-return-state')
    if (el) {
      el.className = 'ifb-return-state ' + state.status
      el.textContent = statusText()
    }
    var chip = byId('ifb-return-chip')
    if (chip) {
      chip.className = 'ifb-return-chip ' + (state.running ? 'active' : state.status === 'error' ? 'error' : '')
      chip.textContent = state.running ? tr('ifbReturnOnAir', 'AL AIRE') : tr('ifbReturnOff', 'APAGADO')
    }
  }

  function renderControls() {
    var config = currentConfig()
    var start = byId('ifb-return-start')
    var refresh = byId('ifb-return-refresh')
    var stop = byId('ifb-return-stop')
    var input = byId('ifb-return-device')
    var inputRefresh = byId('ifb-return-input-refresh')
    if (start) {
      start.disabled = state.running || state.starting || !input || !input.value || !configReady(config)
      start.textContent = state.starting ? tr('ifbReturnStarting', 'PREPARANDO…') : tr('ifbReturnStart', 'INICIAR RETORNO')
    }
    if (stop) stop.disabled = !state.running
    if (refresh) {
      refresh.disabled = !state.running || state.refreshing
      refresh.textContent = state.refreshing ? tr('ifbReturnRefreshing', 'ACTUALIZANDO…') : tr('ifbReturnRefresh', 'ACTUALIZAR TALENTS')
    }
    if (input) input.disabled = state.running || state.starting
    if (inputRefresh) inputRefresh.disabled = state.running || state.starting || state.inputListPending
  }

  async function requestInputAccess() {
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
      var unsupported = new Error(tr('ifbReturnUnsupported', 'ESTA VERSIÓN NO ADMITE ENTRADAS DE AUDIO'))
      unsupported.name = 'NotSupportedError'
      throw unsupported
    }
    // Electron does not expose the audio-device list until the renderer has
    // received a microphone grant. Open a short, silent probe stream only to
    // obtain that grant; the real selected input is opened later by Start.
    var probe = await navigator.mediaDevices.getUserMedia({ audio: true, video: false })
    probe.getTracks().forEach(function (track) { try { track.stop() } catch (error) {} })
  }

  async function listInputs(forceAccess) {
    var select = byId('ifb-return-device')
    if (!select || state.running || state.starting || state.inputListPending) return
    if (!navigator.mediaDevices || !navigator.mediaDevices.enumerateDevices) {
      state.status = 'error'
      state.statusText = tr('ifbReturnUnsupported', 'ESTA VERSIÓN NO ADMITE ENTRADAS DE AUDIO')
      renderStatus()
      renderControls()
      return
    }

    state.inputListPending = true
    state.inputAccessError = null
    try {
      var devices = await navigator.mediaDevices.enumerateDevices()
      var inputs = devices.filter(function (device) { return device.kind === 'audioinput' })
      // On a fresh Electron install enumerateDevices() commonly returns an
      // empty list until getUserMedia() has been granted once. Request that
      // narrow audio-only permission and enumerate again, without keeping the
      // probe stream open or transmitting anything.
      if (!inputs.length && (forceAccess || !state.inputAccessAttempted)) {
        state.inputAccessAttempted = true
        state.status = 'connecting'
        state.statusText = tr('ifbReturnRequestingInput', 'SOLICITANDO ACCESO A ENTRADAS…')
        renderStatus()
        renderControls()
        try {
          await requestInputAccess()
          devices = await navigator.mediaDevices.enumerateDevices()
          inputs = devices.filter(function (device) { return device.kind === 'audioinput' })
        } catch (error) {
          state.inputAccessError = error
        }
      }
      // The host may rebuild the optional card while this async scan is
      // waiting for macOS permission or enumerateDevices(). Always resolve the
      // current select before painting so a stale detached card cannot swallow
      // the result and leave the visible selector empty.
      select = byId('ifb-return-device')
      if (!select || state.running || state.starting) return
      select.innerHTML = ''
      if (!inputs.length) {
        var none = document.createElement('option')
        none.value = ''
        none.textContent = tr('ifbReturnNoInput', 'No hay entradas de audio disponibles')
        select.appendChild(none)
        state.status = 'error'
        state.statusText = state.inputAccessError
          ? messageFor(state.inputAccessError)
          : tr('ifbReturnNoInputState', 'SIN ENTRADA DE AUDIO')
      } else {
        state.inputAccessError = null
        inputs.forEach(function (device, index) {
          var option = document.createElement('option')
          option.value = device.deviceId
          option.textContent = device.label || tr('ifbReturnInputNumber', 'Entrada de audio {n}').replace('{n}', index + 1)
          if (device.deviceId === state.deviceId || (!state.deviceId && index === 0)) option.selected = true
          select.appendChild(option)
        })
        state.deviceId = select.value
        state.deviceLabel = select.options[select.selectedIndex].textContent
        if (state.status !== 'error') {
          state.status = 'idle'
          state.statusText = tr('ifbReturnReady', 'LISTO PARA INICIAR EL RETORNO')
        }
      }
    } catch (error) {
      state.status = 'error'
      state.statusText = tr('ifbReturnInputsFailed', 'NO SE PUDIERON LEER LAS ENTRADAS DE AUDIO')
    } finally {
      state.inputListPending = false
    }
    renderStatus()
    renderControls()
  }

  function stopMeter() {
    if (state.meterFrame) cancelAnimationFrame(state.meterFrame)
    state.meterFrame = 0
    if (state.source) {
      try { state.source.disconnect() } catch (error) {}
      state.source = null
    }
    if (state.analyser) {
      try { state.analyser.disconnect() } catch (error) {}
      state.analyser = null
    }
    if (state.meterSink) {
      try { state.meterSink.disconnect() } catch (error) {}
      state.meterSink = null
    }
    if (state.audioCtx) {
      state.audioCtx.close().catch(function () {})
      state.audioCtx = null
    }
    var fill = byId('ifb-return-meter-fill')
    var value = byId('ifb-return-meter-value')
    if (fill) fill.style.width = '0%'
    if (value) value.textContent = '0%'
  }

  function stopCaptureGraph() {
    if (state.captureSource) {
      try { state.captureSource.disconnect() } catch (error) {}
      state.captureSource = null
    }
    if (state.captureGain) {
      try { state.captureGain.disconnect() } catch (error) {}
      state.captureGain = null
    }
    if (state.captureLimiter) {
      try { state.captureLimiter.disconnect() } catch (error) {}
      state.captureLimiter = null
    }
    if (state.captureDestination) {
      try { state.captureDestination.disconnect() } catch (error) {}
      state.captureDestination = null
    }
    if (state.captureTrack) {
      try { state.captureTrack.stop() } catch (error) {}
      state.captureTrack = null
    }
    if (state.captureStream) {
      state.captureStream.getTracks().forEach(function (track) {
        try { track.stop() } catch (error) {}
      })
      state.captureStream = null
    }
  }

  function drawMeter() {
    if (!state.analyser) return
    var samples = new Float32Array(state.analyser.fftSize)
    if (typeof state.analyser.getFloatTimeDomainData === 'function') {
      state.analyser.getFloatTimeDomainData(samples)
    } else {
      var bytes = new Uint8Array(state.analyser.fftSize)
      state.analyser.getByteTimeDomainData(bytes)
      for (var b = 0; b < bytes.length; b++) samples[b] = (bytes[b] - 128) / 128
    }
    var sum = 0
    for (var i = 0; i < samples.length; i++) {
      sum += samples[i] * samples[i]
    }
    var level = Math.min(100, Math.round(Math.sqrt(sum / samples.length) * 320))
    var fill = byId('ifb-return-meter-fill')
    var value = byId('ifb-return-meter-value')
    if (fill) fill.style.width = level + '%'
    if (value) value.textContent = level + '%'
    state.meterFrame = requestAnimationFrame(drawMeter)
  }

  function startMeter(track) {
    var AudioContextClass = window.AudioContext || window.webkitAudioContext
    if (!AudioContextClass || !track || !track.mediaStreamTrack) return
    try {
      // Prefer a context created by the Start button's user gesture. Creating
      // it only after the token/LiveKit awaits can leave Chromium's context in
      // `suspended`, which produces a permanently flat meter even though the
      // published track is valid.
      if (!state.audioCtx) state.audioCtx = new AudioContextClass()
      state.source = state.audioCtx.createMediaStreamSource(new MediaStream([track.mediaStreamTrack]))
      state.analyser = state.audioCtx.createAnalyser()
      state.analyser.fftSize = 1024
      state.analyser.smoothingTimeConstant = 0.2
      state.source.connect(state.analyser)
      // An analyser that is left at the end of a graph is optimized away by
      // some Chromium/Electron audio backends. Keep it alive through a zero-
      // gain sink so metering works without feeding the input back to speakers.
      state.meterSink = state.audioCtx.createGain()
      state.meterSink.gain.value = 0
      state.analyser.connect(state.meterSink)
      state.meterSink.connect(state.audioCtx.destination)
      state.audioCtx.resume().catch(function () {})
      drawMeter()
    } catch (error) {
      // Metering is informative only. A console input must still be able to
      // publish when an older renderer lacks Web Audio support.
      stopMeter()
    }
  }

  function prepareMeterContext() {
    var AudioContextClass = window.AudioContext || window.webkitAudioContext
    if (!AudioContextClass || state.audioCtx) return
    try {
      state.audioCtx = new AudioContextClass()
      if (state.audioCtx.state === 'suspended') state.audioCtx.resume().catch(function () {})
    } catch (error) {
      state.audioCtx = null
    }
  }

  function authIsValid(data, allowEmptyRecipients) {
    return data && typeof data.token === 'string' && data.token.length > 20 &&
      typeof data.livekitUrl === 'string' && /^wss?:\/\//.test(data.livekitUrl) &&
      data.identity === 'tallybridge-ifb-return' &&
      data.trackName === 'ifb-program-minus' &&
      Array.isArray(data.talentIdentities) && (allowEmptyRecipients || data.talentIdentities.length > 0) &&
      data.talentIdentities.every(function (identity) { return typeof identity === 'string' && /^[a-z0-9-]{1,128}$/i.test(identity) })
  }

  function messageFor(error) {
    if (error && error.name === 'NotAllowedError') return tr('ifbReturnPermissionDenied', 'PERMISO DE ENTRADA DENEGADO')
    if (error && error.name === 'NotFoundError') return tr('ifbReturnDeviceMissing', 'LA ENTRADA SELECCIONADA NO ESTÁ DISPONIBLE')
    return error && error.message ? error.message : tr('ifbReturnFailed', 'NO SE PUDO INICIAR EL RETORNO')
  }

  async function requestAuthorization(allowEmptyRecipients) {
    var config = currentConfig()
    var response = await fetch('/api/ifb/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ room: config.room, apiKey: config.apiKey })
    })
    var data = await response.json().catch(function () { return { error: tr('ifbReturnTokenInvalid', 'RESPUESTA IFB INVÁLIDA') } })
    if (!response.ok) throw new Error(data.error || tr('ifbReturnTokenFailed', 'NO SE PUDO AUTORIZAR EL RETORNO'))
    if (!authIsValid(data, !!allowEmptyRecipients)) throw new Error(tr('ifbReturnTokenInvalid', 'RESPUESTA IFB INVÁLIDA'))
    return data
  }

  async function refreshRecipients() {
    if (!state.running || !state.room || state.refreshing || state.stopping) return
    var targetRoom = state.room
    state.refreshing = true
    state.status = 'connecting'
    state.statusText = tr('ifbReturnRefreshing', 'ACTUALIZANDO DESTINATARIOS…')
    renderStatus()
    renderControls()
    try {
      var auth = await requestAuthorization(true)
      // A roster refresh must remain bound to the same event transport. If the
      // event changed underneath us, keep the current source alive and ask the
      // operator to restart it deliberately rather than repointing mid-show.
      if (state.stopping || !state.running || state.room !== targetRoom || !state.auth ||
          auth.livekitUrl !== state.auth.livekitUrl || auth.room !== state.auth.room ||
          auth.identity !== state.auth.identity || auth.trackName !== state.auth.trackName) {
        if (!state.stopping && state.running) {
          state.status = 'active'
          state.statusText = tr('ifbReturnRecipientsFailed', 'NO SE ACTUALIZARON LOS DESTINATARIOS; RETORNO ACTIVO')
        }
        return
      }
      targetRoom.localParticipant.setTrackSubscriptionPermissions(false,
        auth.talentIdentities.map(function (identity) {
          return { participantIdentity: identity, allowAll: true }
        })
      )
      state.auth = auth
      state.status = 'active'
      state.statusText = tr('ifbReturnRecipientsUpdated', 'DESTINATARIOS TALENT ACTUALIZADOS')
    } catch (error) {
      if (!state.stopping && state.running) {
        state.status = 'active'
        state.statusText = tr('ifbReturnRecipientsFailed', 'NO SE ACTUALIZARON LOS DESTINATARIOS; RETORNO ACTIVO')
      }
    } finally {
      state.refreshing = false
      renderStatus()
      renderControls()
    }
  }

  async function release() {
    var room = state.room
    var track = state.track
    state.room = null
    state.track = null
    state.auth = null
    state.running = false
    state.refreshing = false
    if (room && track) {
      try { await room.localParticipant.unpublishTrack(track) } catch (error) {}
    }
    if (track) {
      try { track.stop() } catch (error) {}
    }
    stopCaptureGraph()
    stopMeter()
    if (room) {
      try { await room.disconnect() } catch (error) {}
    }
  }

  async function stop(reason) {
    if (state.stopping) return
    if (!state.room && !state.track && !state.starting && !state.running) return
    state.stopping = true
    try {
      await release()
      state.status = 'idle'
      state.statusText = reason === 'bridge-disconnected'
        ? tr('ifbReturnBridgeStopped', 'RETORNO DETENIDO AL DESCONECTAR TALLYBRIDGE')
        : tr('ifbReturnStopped', 'RETORNO DETENIDO')
    } finally {
      state.starting = false
      state.stopping = false
      renderStatus()
      renderControls()
      // A manual stop must leave the input chooser immediately usable.
      if (!state.running) void listInputs()
    }
  }

  async function failStart(error) {
    state.stopping = true
    try { await release() } finally {
      state.starting = false
      state.stopping = false
      state.status = 'error'
      state.statusText = messageFor(error)
      renderStatus()
      renderControls()
      // A failed authorization/connection must leave the input chooser ready
      // for another attempt. If the card was re-rendered during `starting`,
      // its new select is empty until this refresh repopulates it.
      if (!state.running) void listInputs()
    }
  }

  async function start() {
    if (state.running || state.starting || state.stopping) return
    var input = byId('ifb-return-device')
    state.deviceId = input && input.value ? input.value : ''
    if (!state.deviceId) {
      state.status = 'error'
      state.statusText = tr('ifbReturnChooseInput', 'ELEGÍ UNA ENTRADA DE CONSOLA')
      renderStatus()
      renderControls()
      return
    }
    var config = currentConfig()
    if (!config.room) {
      state.status = 'error'
      state.statusText = tr('ifbReturnNeedRoom', 'INGRESÁ LA SALA DE TALLYCOMM')
      renderStatus()
      renderControls()
      return
    }
    if (!config.apiKey) {
      state.status = 'error'
      state.statusText = tr('ifbReturnNeedApiKey', 'INGRESÁ LA API KEY DEL EVENTO')
      renderStatus()
      renderControls()
      return
    }
    // Save the independent IFB credentials without coupling them to the
    // switcher connection. Failure to persist does not block a live start;
    // the current values are still sent to the local proxy below.
    void persistConfig(config)
    prepareMeterContext()
    if (!window.LivekitClient || !window.LivekitClient.Room || !window.LivekitClient.createLocalAudioTrack) {
      state.status = 'error'
      state.statusText = tr('ifbReturnSdkMissing', 'EL MÓDULO DE RETORNO NO ESTÁ DISPONIBLE')
      renderStatus()
      renderControls()
      return
    }

    state.starting = true
    state.status = 'connecting'
    state.statusText = tr('ifbReturnAuthorizing', 'VALIDANDO RETORNO IFB…')
    renderStatus()
    renderControls()

    try {
      var auth = await requestAuthorization()
      var LK = window.LivekitClient
      state.statusText = tr('ifbReturnConnecting', 'CONECTANDO RETORNO IFB…')
      renderStatus()
      var room = new LK.Room({ adaptiveStream: false, dynacast: false })
      state.room = room
      room.on(LK.RoomEvent.Disconnected, function () {
        if (state.stopping || !state.room) return
        state.stopping = true
        release().then(function () {
          state.starting = false
          state.stopping = false
          state.status = 'error'
          state.statusText = tr('ifbReturnConnectionLost', 'SE PERDIÓ LA CONEXIÓN DEL RETORNO')
          renderStatus()
          renderControls()
          if (!state.running) void listInputs()
        })
      })
      await room.connect(auth.livekitUrl, auth.token, { autoSubscribe: false })

      // This is set before a track exists: any identity absent from this exact
      // event roster is denied, including camera and crew identities.
      room.localParticipant.setTrackSubscriptionPermissions(false,
        auth.talentIdentities.map(function (identity) {
          return { participantIdentity: identity, allowAll: true }
        })
      )

      state.statusText = tr('ifbReturnOpeningInput', 'ABRIENDO ENTRADA DE CONSOLA…')
      renderStatus()
      // Capture through a Web Audio gain stage before handing the track to
      // LiveKit. A console/Program-Minus feed often arrives 10–15 dB below a
      // browser microphone's nominal level; a 12 dB trim restores usable
      // headroom while the Bridge meter shows the post-trim signal. Talent
      // remains at unity and uses the phone's hardware volume.
      var inputConstraints = {
        audio: {
          deviceId: { exact: state.deviceId },
          echoCancellation: false,
          noiseSuppression: false,
          autoGainControl: false,
          channelCount: { ideal: 2 }
        },
        video: false
      }
      state.captureStream = await navigator.mediaDevices.getUserMedia(inputConstraints)
      state.captureTrack = state.captureStream.getAudioTracks()[0]
      if (!state.captureTrack) throw new Error('No audio track from selected input')
      state.captureTrack.enabled = true
      if (!state.audioCtx) prepareMeterContext()
      if (!state.audioCtx) throw new Error('Audio context unavailable')
      await state.audioCtx.resume().catch(function () {})
      state.captureSource = state.audioCtx.createMediaStreamSource(state.captureStream)
      state.captureGain = state.audioCtx.createGain()
      state.captureGain.gain.value = 4
      // Keep the fixed recovery gain from clipping a hot line-level feed. The
      // limiter is intentionally gentle and lives before the published track;
      // the Bridge meter therefore shows exactly what Talent receives.
      state.captureLimiter = state.audioCtx.createDynamicsCompressor()
      state.captureLimiter.threshold.value = -3
      state.captureLimiter.knee.value = 6
      state.captureLimiter.ratio.value = 12
      state.captureLimiter.attack.value = 0.003
      state.captureLimiter.release.value = 0.25
      state.captureDestination = state.audioCtx.createMediaStreamDestination()
      state.captureSource.connect(state.captureGain)
      state.captureGain.connect(state.captureLimiter)
      state.captureLimiter.connect(state.captureDestination)
      var processedTrack = state.captureDestination.stream.getAudioTracks()[0]
      if (!processedTrack) throw new Error('No processed audio track')
      processedTrack.enabled = true
      var track = new LK.LocalAudioTrack(processedTrack, { deviceId: { exact: state.deviceId } })
      state.track = track
      // Some macOS input routes are returned muted until the first consumer
      // explicitly enables the MediaStreamTrack. LiveKit normally does this
      // itself, but making it explicit prevents a published-but-silent IFB.
      if (track.mediaStreamTrack) track.mediaStreamTrack.enabled = true
      if (typeof track.unmute === 'function') track.unmute()
      track.mediaStreamTrack.onended = function () {
        if (!state.stopping && state.running) void stop('input-ended')
      }
      await room.localParticipant.publishTrack(track, {
        name: auth.trackName,
        source: LK.Track.Source.Microphone
      })
      state.auth = auth
      state.running = true
      state.starting = false
      state.status = 'active'
      state.statusText = tr('ifbReturnActive', 'PROGRAM-MINUS ACTIVO PARA TALENT AUTORIZADO')
      startMeter(track)
      renderStatus()
      renderControls()
      // Device labels often become available only after the explicit input
      // grant. Refreshing does not change an active selection.
      navigator.mediaDevices.enumerateDevices().catch(function () {})
    } catch (error) {
      await failStart(error)
    }
  }

  function mount() {
    var slot = byId('ifb-return-slot')
    if (!slot) return
    // Status events arrive while a show is running. Keep the existing card so
    // operator focus, typed credentials, and the selected input are not wiped
    // out on every tally update; render only when the host screen created a
    // fresh slot.
    if (!byId('ifb-return-card')) slot.innerHTML = cardHtml()
    if (byId('ifb-return-card') && byId('ifb-return-room') && byId('ifb-return-room').dataset.ifbWired === '1') {
      renderStatus()
      renderControls()
      var existingInput = byId('ifb-return-device')
      if (!state.running && !state.starting && existingInput && !existingInput.options.length) void listInputs()
      return
    }
    ;['ifb-return-room', 'ifb-return-api-key'].forEach(function (id) {
      var field = byId(id)
      if (!field) return
      field.dataset.ifbWired = '1'
      field.addEventListener('input', function () {
        rememberConfig(currentConfig())
        renderControls()
      })
      field.addEventListener('change', function () {
        void persistConfig(currentConfig())
      })
    })
    var input = byId('ifb-return-device')
    if (input) input.addEventListener('change', function () {
      state.deviceId = input.value
      state.deviceLabel = input.options[input.selectedIndex].textContent
      if (state.status === 'error') {
        state.status = 'idle'
        state.statusText = tr('ifbReturnReady', 'LISTO PARA INICIAR EL RETORNO')
      }
      renderStatus()
      renderControls()
    })
    var startButton = byId('ifb-return-start')
    var refreshButton = byId('ifb-return-refresh')
    var stopButton = byId('ifb-return-stop')
    var inputRefreshButton = byId('ifb-return-input-refresh')
    if (startButton) startButton.addEventListener('click', function () { void start() })
    if (refreshButton) refreshButton.addEventListener('click', function () { void refreshRecipients() })
    if (stopButton) stopButton.addEventListener('click', function () { void stop('manual') })
    if (inputRefreshButton) inputRefreshButton.addEventListener('click', function () {
      state.inputAccessAttempted = false
      void listInputs(true)
    })
    renderStatus()
    renderControls()
    if (!state.running && !state.starting) void listInputs()
  }

  window.addEventListener('beforeunload', function () { void stop('page-unload') })
  window.addEventListener('pagehide', function () { void stop('page-unload') })
  if (navigator.mediaDevices) {
    navigator.mediaDevices.addEventListener('devicechange', function () {
      if (!state.running && !state.starting) void listInputs()
    })
  }

  window.TallyBridgeIfbReturn = { mount: mount, stop: stop }
})()
