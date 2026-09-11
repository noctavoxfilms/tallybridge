# TallyBridge v1.5.14 — TallyComm

TallyBridge conecta switchers de video y una entrada de consola de audio con [TallyComm](https://tallycomm.com). La app de escritorio puede operar dos rutas independientes y simultáneas:

- **Tally:** PGM/PVW desde el switcher hacia cámaras.
- **IFB + Cue:** Program-Minus desde la consola y Cue privado del Director hacia Talent.

No hace falta instalar Bitfocus Companion. El módulo IFB también puede funcionar sin conectar ningún switcher.

## Descargar

Usa la página oficial de [TallyBridge](https://tallycomm.com/bridge), que detecta la plataforma y enlaza el release vigente. Los artefactos también están en [GitHub Releases](https://github.com/noctavoxfilms/tallybridge/releases/latest):

- **Mac Apple Silicon:** `TallyBridge-*-arm64.dmg`, firmado y notarizado por Apple.
- **Mac Intel:** `TallyBridge-*.dmg`, firmado y notarizado por Apple.
- **Windows x64/ARM64:** `TallyBridge.Setup.*.exe`, instalador universal sin firma comercial de Windows.

En Mac debe abrirse la app instalada desde el DMG. Un `.app` suelto producido por un build local puede estar firmado ad hoc pero no notarizado y Gatekeeper lo rechazará; eso no describe el DMG publicado.

## Switchers soportados

| Switcher | Protocolo |
|----------|-----------|
| OBS Studio | WebSocket v5 |
| vMix | TCP API |
| Blackmagic ATEM | `atem-connection` |
| NewTek/Vizrt TriCaster | HTTP + WebSocket v1 |
| Roland Smart Tally | HTTP |
| Osee GoStream | TCP :19010 |
| RGBlink mini | UDP :1000 |
| AVMatrix | UDP :19523/:19522 |

Los buses PGM/PVW aceptan varias cámaras simultáneas cuando el switcher reporta composiciones, overlays, keyers o transiciones.

## Uso de Tally

1. Abre TallyBridge y escribe el código de evento y su Switcher API Key.
2. Selecciona el switcher y completa sus datos de red.
3. Usa **PROBAR** para verificar la conexión sin enviar tally.
4. Asigna fuentes a CAM 1–8 o usa el mapeo automático cuando esté disponible.
5. Selecciona **CONECTAR TALLY**.

La pérdida del switcher apaga PGM/PVW de forma segura. La ruta IFB, si está activa, continúa funcionando de manera independiente.

## Uso de IFB + Cue

1. Configura el mismo evento y API key.
2. En la zona IFB, elige la entrada que recibe el Program-Minus preparado por la consola.
3. Selecciona **INICIAR RUTA IFB**. No es necesario conectar Tally.
4. Talent recibe una sola salida `ifb-program-minus` desde Bridge.
5. Cuando un Director mantiene **CUE A TALENTO**, Bridge mezcla su voz privadamente y atenúa Program-Minus 12 dB sólo mientras detecta voz real.

Program-Minus entra a ganancia unitaria. La consola define el nivel nominal; Bridge conserva un limitador para picos inesperados. Talent ajusta la escucha con el volumen físico del teléfono o audífonos y dispone de mute IFB explícito.

Estados esperados del Cue:

- `LISTO PARA CUE DEL DIRECTOR`
- `DIRECTOR CONECTANDO`
- `CUE CONECTADO · ESPERANDO AUDIO`
- `DIRECTOR HABLANDO · AUDIO DE PROGRAMA ATENUADO`

La publicación Cue no pertenece a CAMS/PROD. El servidor autoriza sólo a Directores, usa una sala privada y un lease con expiración; Bridge es el único mezclador y Talent permanece receive-only.

## Qué corrigió v1.5.14

- Electron recibía RTP del Cue pero Web Audio obtenía silencio. Ahora `RemoteAudioTrack.attach()` inicia el playout/decodificación en un elemento local muteado y su `srcObject` alimenta el mixer.
- El duck ya no se activa por la mera existencia de un track: requiere señal por encima de aproximadamente -44 dBFS durante dos frames y conserva unos 250 ms de release.
- Se retiró el boost fijo de +12 dB que hacía demasiado alto el IFB; Program-Minus queda en unity.
- El selector conserva el nombre de la entrada mientras la ruta está activa o la UI se reconstruye.
- Los estados Cue están localizados EN/ES.
- La Signal Console cabe completa en la ventana mínima 800×600: ocho logos, configuración Tally y controles IFB sin scroll ni botones recortados.
- La interfaz visible no usa emojis.

## Verificación E2E de referencia

El 11 de septiembre de 2026 se validó la cadena real Mac Director → LiveKit Cue privado → TallyBridge → mixer IFB → iOS Talent. Bridge registró la secuencia completa de conexión/voz/restauración, un pico Cue de 71 % y el usuario confirmó la escucha de la frase privada en Talent.

Queda pendiente ampliar la matriz a Director Android físico, Bluetooth/AirPods, pérdida de red durante Cue, dos Directores simultáneos y feeds Program-Minus silencioso/nominal/caliente.

## Desarrollo

Requiere Node.js 18 o superior.

```bash
npm install
npm start          # servidor local
npm run electron   # app Electron
npm run build:mac
npm run build:win
```

Antes de un release:

```bash
node --check ifb-return.js
node --check ifb-cue.js
git diff --check
```

El tag `vX.Y.Z` dispara GitHub Actions: Windows universal y dos DMG de Mac firmados/notarizados. Consulta [BUILD.md](BUILD.md) para el procedimiento y las verificaciones de firma.

## TallyBridge vs Companion

| | TallyBridge | Companion Module |
|---|---|---|
| Instalación | App de escritorio | Plugin dentro de Companion |
| Switchers | 8 integraciones directas | 700+ mediante Companion |
| Tally PGM/PVW | Sí | Sí |
| IFB Program-Minus + Cue | Sí | No |
| Configuración | Guiada | Flexible/manual |

Ambos usan el endpoint protegido `POST /api/tally`; IFB y Cue usan endpoints LiveKit aislados adicionales.

---

[TallyComm](https://tallycomm.com) — Noctavox
