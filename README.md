# TallyBridge v1.0 — TallyComm

Conecta OBS Studio (y próximamente ATEM, vMix, RGBlink) a TallyComm
sin instalar Companion ni TallyArbiter.

## Requisitos

- Node.js 18 o superior → https://nodejs.org
- OBS Studio 28+ (incluye WebSocket v5 integrado)

## Instalación

```bash
# 1. Descomprime esta carpeta en tu escritorio o documentos
# 2. Abre Terminal y navega a la carpeta:
cd ~/Desktop/tallybridge

# 3. Instala dependencias (solo la primera vez):
npm install

# 4. Inicia TallyBridge:
node bridge.js
```

El browser se abre automáticamente en http://localhost:4000

## Configurar OBS

1. En OBS: **Tools → WebSocket Server Settings**
2. Activa **"Enable WebSocket Server"**
3. Puerto: `4455` (por defecto)
4. Si quieres contraseña, escríbela — si no, deja desactivada la autenticación
5. Click **OK**

## Uso

1. Abre TallyBridge (`node bridge.js`)
2. En la UI: ingresa el nombre de sala (igual que en TallyComm)
3. Click **CONECTAR**
4. TallyBridge detecta todas las escenas de OBS automáticamente
5. Asigna cada escena a una cámara (1-6) o usa **AUTO-DETECTAR**
   - Auto-detecta si los nombres siguen el patrón: "Camera 1", "CAM 2", "Cámara 3", etc.
6. Cuando cambies de escena en OBS, el tally llega instantáneamente a los camarógrafos

## Detener

Presiona **Ctrl+C** en la terminal.

## Compatibilidad

| Switcher   | Estado        |
|------------|---------------|
| OBS Studio | ✅ Disponible  |
| ATEM       | 🔜 Próximamente |
| vMix       | 🔜 Próximamente |
| RGBlink    | 🔜 Próximamente |

---
TallyComm — tallycomm.com
