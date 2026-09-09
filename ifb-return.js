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
    meterFrame: 0,
    running: false,
    starting: false,
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
    return [
      '<section class="ifb-return" aria-labelledby="ifb-return-title">',
      '  <div class="ifb-return-head">',
      '    <div>',
      '      <div class="ifb-return-kicker">IFB RETURN · PROGRAM-MINUS</div>',
      '      <div class="ifb-return-title" id="ifb-return-title">' + escapeHtml(tr('ifbReturnTitle', 'RETORNO PARA TALENT')) + '</div>',
      '    </div>',
      '    <div class="ifb-return-chip ' + (active ? 'active' : state.status === 'error' ? 'error' : '') + '" id="ifb-return-chip">' +
            (active ? escapeHtml(tr('ifbReturnOnAir', 'AL AIRE')) : escapeHtml(tr('ifbReturnOff', 'APAGADO'))) + '</div>',
      '  </div>',
      '  <p class="ifb-return-note">' + escapeHtml(tr('ifbReturnNote', 'Publica la mezcla Program-Minus seleccionada únicamente a los talentos autorizados. No abre el intercom de cámaras ni crew.')) + '</p>',
      '  <div class="ifb-return-controls">',
      '    <label class="field"><span class="field-label">' + escapeHtml(tr('ifbReturnInput', 'ENTRADA DE CONSOLA')) + '</span>',
      '      <select class="input" id="ifb-return-device" ' + (active || state.starting ? 'disabled' : '') + '>' +
                (active ? '<option value="' + escapeHtml(state.deviceId) + '">' + escapeHtml(state.deviceLabel || tr('ifbReturnSelectedInput', 'Entrada seleccionada')) + '</option>' : '') +
              '</select>',
      '    </label>',
      '    <div class="ifb-return-meter-wrap">',
      '      <div class="ifb-return-meter" aria-label="' + escapeHtml(tr('ifbReturnLevel', 'Nivel de entrada')) + '"><div class="ifb-return-meter-fill" id="ifb-return-meter-fill"></div></div>',
      '      <div class="ifb-return-meter-label"><span>' + escapeHtml(tr('ifbReturnLevel', 'NIVEL DE ENTRADA')) + '</span><strong id="ifb-return-meter-value">0%</strong></div>',
      '    </div>',
      '    <div class="ifb-return-actions">',
      '      <button class="ifb-return-start" id="ifb-return-start" type="button" ' + (active || state.starting ? 'disabled' : '') + '>' + escapeHtml(state.starting ? tr('ifbReturnStarting', 'PREPARANDO…') : tr('ifbReturnStart', 'INICIAR RETORNO')) + '</button>',
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
    var start = byId('ifb-return-start')
    var stop = byId('ifb-return-stop')
    var input = byId('ifb-return-device')
    if (start) {
      start.disabled = state.running || state.starting || !input || !input.value
      start.textContent = state.starting ? tr('ifbReturnStarting', 'PREPARANDO…') : tr('ifbReturnStart', 'INICIAR RETORNO')
    }
    if (stop) stop.disabled = !state.running
    if (input) input.disabled = state.running || state.starting
  }

  async function listInputs() {
    var select = byId('ifb-return-device')
    if (!select || state.running || state.starting) return
    if (!navigator.mediaDevices || !navigator.mediaDevices.enumerateDevices) {
      state.status = 'error'
      state.statusText = tr('ifbReturnUnsupported', 'ESTA VERSIÓN NO ADMITE ENTRADAS DE AUDIO')
      renderStatus()
      renderControls()
      return
    }

    try {
      var devices = await navigator.mediaDevices.enumerateDevices()
      var inputs = devices.filter(function (device) { return device.kind === 'audioinput' })
      select.innerHTML = ''
      if (!inputs.length) {
        var none = document.createElement('option')
        none.value = ''
        none.textContent = tr('ifbReturnNoInput', 'No hay entradas de audio disponibles')
        select.appendChild(none)
        state.status = 'error'
        state.statusText = tr('ifbReturnNoInputState', 'SIN ENTRADA DE AUDIO')
      } else {
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
    if (state.audioCtx) {
      state.audioCtx.close().catch(function () {})
      state.audioCtx = null
    }
    var fill = byId('ifb-return-meter-fill')
    var value = byId('ifb-return-meter-value')
    if (fill) fill.style.width = '0%'
    if (value) value.textContent = '0%'
  }

  function drawMeter() {
    if (!state.analyser) return
    var samples = new Uint8Array(state.analyser.fftSize)
    state.analyser.getByteTimeDomainData(samples)
    var sum = 0
    for (var i = 0; i < samples.length; i++) {
      var normalized = (samples[i] - 128) / 128
      sum += normalized * normalized
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
      state.audioCtx = new AudioContextClass()
      state.source = state.audioCtx.createMediaStreamSource(new MediaStream([track.mediaStreamTrack]))
      state.analyser = state.audioCtx.createAnalyser()
      state.analyser.fftSize = 1024
      state.source.connect(state.analyser)
      state.audioCtx.resume().catch(function () {})
      drawMeter()
    } catch (error) {
      // Metering is informative only. A console input must still be able to
      // publish when an older renderer lacks Web Audio support.
      stopMeter()
    }
  }

  function authIsValid(data) {
    return data && typeof data.token === 'string' && data.token.length > 20 &&
      typeof data.livekitUrl === 'string' && /^wss?:\/\//.test(data.livekitUrl) &&
      data.identity === 'tallybridge-ifb-return' &&
      data.trackName === 'ifb-program-minus' &&
      Array.isArray(data.talentIdentities) && data.talentIdentities.length > 0 &&
      data.talentIdentities.every(function (identity) { return typeof identity === 'string' && /^[a-z0-9-]{1,128}$/i.test(identity) })
  }

  function messageFor(error) {
    if (error && error.name === 'NotAllowedError') return tr('ifbReturnPermissionDenied', 'PERMISO DE ENTRADA DENEGADO')
    if (error && error.name === 'NotFoundError') return tr('ifbReturnDeviceMissing', 'LA ENTRADA SELECCIONADA NO ESTÁ DISPONIBLE')
    return error && error.message ? error.message : tr('ifbReturnFailed', 'NO SE PUDO INICIAR EL RETORNO')
  }

  async function requestAuthorization() {
    var response = await fetch('/api/ifb/token', { method: 'POST' })
    var data = await response.json().catch(function () { return { error: tr('ifbReturnTokenInvalid', 'RESPUESTA IFB INVÁLIDA') } })
    if (!response.ok) throw new Error(data.error || tr('ifbReturnTokenFailed', 'NO SE PUDO AUTORIZAR EL RETORNO'))
    if (!authIsValid(data)) throw new Error(tr('ifbReturnTokenInvalid', 'RESPUESTA IFB INVÁLIDA'))
    return data
  }

  async function release() {
    stopMeter()
    var room = state.room
    var track = state.track
    state.room = null
    state.track = null
    state.auth = null
    state.running = false
    if (room && track) {
      try { await room.localParticipant.unpublishTrack(track) } catch (error) {}
    }
    if (track) {
      try { track.stop() } catch (error) {}
    }
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
      var track = await LK.createLocalAudioTrack({
        deviceId: { exact: state.deviceId },
        echoCancellation: false,
        noiseSuppression: false,
        autoGainControl: false,
        channelCount: { ideal: 2 }
      })
      state.track = track
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
    slot.innerHTML = cardHtml()
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
    var stopButton = byId('ifb-return-stop')
    if (startButton) startButton.addEventListener('click', function () { void start() })
    if (stopButton) stopButton.addEventListener('click', function () { void stop('manual') })
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
