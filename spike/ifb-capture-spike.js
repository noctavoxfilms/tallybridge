/*
 * TallyBridge IFB capture capability probe.
 *
 * Deliberately does NOT import LiveKit, call TallyComm, persist a device ID,
 * or transmit audio. It proves the first contract of an IFB return bridge:
 * Electron can obtain a chosen console input once, keep it open, and measure
 * its level. Load only with TallyBridge's local URL plus ?ifb-spike=1.
 */
(function () {
  'use strict'

  if (new URLSearchParams(location.search).get('ifb-spike') !== '1') return

  // Let the pre-existing TallyBridge SSE handlers know that this opt-in probe
  // owns the main surface. This flag has no effect on normal launches.
  window.TallyBridgeIfbCaptureSpike = true

  var stream = null
  var audioCtx = null
  var source = null
  var analyser = null
  var meterFrame = 0

  function byId(id) { return document.getElementById(id) }

  function setState(kind, text) {
    var el = byId('ifb-spike-state')
    if (!el) return
    el.className = 'ifb-spike-state ' + kind
    el.textContent = text
  }

  function setButtonState(running) {
    var start = byId('ifb-spike-start')
    var stop = byId('ifb-spike-stop')
    var select = byId('ifb-spike-device')
    if (start) start.disabled = running
    if (stop) stop.disabled = !running
    if (select) select.disabled = running
  }

  async function listInputs() {
    var select = byId('ifb-spike-device')
    if (!select || !navigator.mediaDevices || !navigator.mediaDevices.enumerateDevices) return

    var devices = await navigator.mediaDevices.enumerateDevices()
    var inputs = devices.filter(function (device) { return device.kind === 'audioinput' })
    select.innerHTML = ''

    if (!inputs.length) {
      var none = document.createElement('option')
      none.value = ''
      none.textContent = 'No hay entradas de audio disponibles'
      select.appendChild(none)
      setState('error', 'SIN ENTRADA DE AUDIO')
      return
    }

    inputs.forEach(function (device, index) {
      var option = document.createElement('option')
      option.value = device.deviceId
      option.textContent = device.label || ('Entrada de audio ' + (index + 1))
      select.appendChild(option)
    })
  }

  function stopMeter() {
    if (meterFrame) cancelAnimationFrame(meterFrame)
    meterFrame = 0
    if (source) {
      try { source.disconnect() } catch (e) {}
      source = null
    }
    if (analyser) {
      try { analyser.disconnect() } catch (e) {}
      analyser = null
    }
    if (audioCtx) {
      audioCtx.close().catch(function () {})
      audioCtx = null
    }
  }

  function drawMeter() {
    if (!analyser) return
    var values = new Uint8Array(analyser.fftSize)
    analyser.getByteTimeDomainData(values)
    var sum = 0
    for (var i = 0; i < values.length; i++) {
      var normalized = (values[i] - 128) / 128
      sum += normalized * normalized
    }
    var rms = Math.sqrt(sum / values.length)
    var level = Math.min(100, Math.round(rms * 320))
    var fill = byId('ifb-spike-meter-fill')
    var value = byId('ifb-spike-meter-value')
    if (fill) fill.style.width = level + '%'
    if (value) value.textContent = level + '%'
    meterFrame = requestAnimationFrame(drawMeter)
  }

  async function startCapture() {
    if (stream) return
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
      setState('error', 'ESTA VERSIÓN DE ELECTRON NO ADMITE CAPTURA DE AUDIO')
      return
    }

    var select = byId('ifb-spike-device')
    var deviceId = select && select.value
    if (!deviceId) {
      setState('error', 'ELEGÍ UNA ENTRADA DE CONSOLA')
      return
    }

    setState('connecting', 'SOLICITANDO ENTRADA DE AUDIO…')
    try {
      stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          deviceId: { exact: deviceId },
          echoCancellation: false,
          noiseSuppression: false,
          autoGainControl: false,
          channelCount: { ideal: 2 }
        },
        video: false
      })

      audioCtx = new (window.AudioContext || window.webkitAudioContext)()
      source = audioCtx.createMediaStreamSource(stream)
      analyser = audioCtx.createAnalyser()
      analyser.fftSize = 1024
      source.connect(analyser)
      drawMeter()
      setButtonState(true)
      setState('active', 'ENTRADA CAPTURADA — SIN TRANSMITIR')

      // Labels are often blank until the first permission grant.
      listInputs().catch(function () {})
    } catch (error) {
      stopCapture()
      var message = error && error.name === 'NotAllowedError'
        ? 'PERMISO DE MICRÓFONO / ENTRADA DENEGADO'
        : 'NO SE PUDO ABRIR LA ENTRADA: ' + (error && error.message ? error.message : 'ERROR')
      setState('error', message)
    }
  }

  function stopCapture() {
    if (stream) {
      stream.getTracks().forEach(function (track) { track.stop() })
      stream = null
    }
    stopMeter()
    setButtonState(false)
    var fill = byId('ifb-spike-meter-fill')
    var value = byId('ifb-spike-meter-value')
    if (fill) fill.style.width = '0%'
    if (value) value.textContent = '0%'
    setState('idle', 'LISTO PARA PROBAR UNA ENTRADA')
  }

  function mount() {
    var main = byId('main-area')
    if (!main) return
    main.innerHTML = [
      '<div class="ifb-spike-wrap">',
      '  <div class="ifb-spike-kicker">IFB RETURN · CAPTURE PROBE</div>',
      '  <h1>Probá la entrada de consola</h1>',
      '  <p>Esta prueba solo abre y mide la entrada seleccionada. No guarda configuración ni transmite audio.</p>',
      '  <div class="ifb-spike-card">',
      '    <label for="ifb-spike-device">ENTRADA DE AUDIO</label>',
      '    <select class="input" id="ifb-spike-device"></select>',
      '    <div class="ifb-spike-meter" aria-label="Nivel de entrada"><div id="ifb-spike-meter-fill"></div></div>',
      '    <div class="ifb-spike-level"><span>NIVEL DE ENTRADA</span><strong id="ifb-spike-meter-value">0%</strong></div>',
      '    <div class="ifb-spike-actions">',
      '      <button id="ifb-spike-start" type="button">PROBAR ENTRADA</button>',
      '      <button id="ifb-spike-stop" type="button" disabled>DETENER</button>',
      '    </div>',
      '    <div class="ifb-spike-state idle" id="ifb-spike-state">BUSCANDO ENTRADAS…</div>',
      '  </div>',
      '</div>'
    ].join('')

    byId('ifb-spike-start').addEventListener('click', startCapture)
    byId('ifb-spike-stop').addEventListener('click', stopCapture)
    listInputs().then(function () {
      if (!stream) setState('idle', 'LISTO PARA PROBAR UNA ENTRADA')
    }).catch(function (error) {
      setState('error', 'NO SE PUDIERON ENUMERAR ENTRADAS: ' + error.message)
    })
  }

  window.addEventListener('beforeunload', stopCapture)
  window.addEventListener('load', mount)
}())
