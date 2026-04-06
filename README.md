# TallyBridge v1.2.2 — TallyComm

Conecta tu switcher de video a [TallyComm](https://tallycomm.com) sin instalar Bitfocus Companion. App de escritorio para Mac y Windows.

## Descargar

Descarga el instalador para tu plataforma desde [GitHub Releases](https://github.com/noctavoxfilms/tallybridge/releases/latest):

- **Mac (Apple Silicon):** `TallyBridge-*-arm64.dmg`
- **Mac (Intel):** `TallyBridge-*.dmg`
- **Windows (x64):** `TallyBridge.Setup.*.exe`
- **Windows (ARM64):** `TallyBridge.Setup.*-arm64.exe`

## Switchers soportados

| Switcher | Protocolo | Estado |
|----------|-----------|--------|
| OBS Studio | WebSocket v5 | ✅ Disponible |
| RGBlink mini | UDP (puerto 1000) | ✅ Disponible |
| ATEM | — | 🔜 Próximamente |
| vMix | — | 🔜 Próximamente |

## Uso

1. Abre TallyBridge
2. Selecciona tu switcher (OBS o RGBlink)
3. Ingresa el nombre de sala (el mismo código que usan los operadores en TallyComm)
4. Click **CONECTAR**
5. Asigna cada escena/input a una cámara (1-6), o usa **AUTO-DETECTAR** para OBS
6. Cuando cambies de escena en tu switcher, el tally llega instantáneamente a los camarógrafos

## Configurar OBS

1. En OBS: **Tools → WebSocket Server Settings**
2. Activa **"Enable WebSocket Server"**
3. Puerto: `4455` (por defecto)
4. Si usas contraseña, ingrésala también en TallyBridge
5. Click **OK**

## Configurar RGBlink mini

1. Asegúrate de que el RGBlink mini esté en la misma red que tu computadora
2. En TallyBridge, ingresa la IP del dispositivo (visible en la pantalla del RGBlink)
3. Puerto por defecto: `1000`
4. TallyBridge auto-mapea Input 1 → CAM 1, Input 2 → CAM 2, etc.

## Desarrollo

Requiere Node.js 18+.

```bash
npm install

# Servidor solo (abre el browser)
npm start

# App Electron completa
npm run electron

# Build
npm run build:mac
npm run build:win
npm run build:all
```

## TallyBridge vs Companion

| | TallyBridge | Companion Module |
|---|---|---|
| Instalación | App nativa (DMG/EXE) | Plugin dentro de Companion |
| Configuración | UI auto-detect | Manual en Companion |
| Switchers | OBS, RGBlink | 700+ via Companion |
| Complejidad | Plug and play | Flexible pero requiere setup |

Ambos usan el mismo endpoint `POST /api/tally` de TallyComm.

---
[TallyComm](https://tallycomm.com) — Noctavox Films
