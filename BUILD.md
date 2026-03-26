# TallyBridge — Instrucciones de Build

## Requisitos

- Node.js 18+ → https://nodejs.org
- Para generar `.icns` (Mac): Xcode o herramienta `iconutil`
- Para generar `.ico` (Windows): cualquier conversor online

---

## Setup inicial

```bash
cd ~/Desktop/tallybridge
npm install
```

---

## Generar el ícono (IMPORTANTE — hacer antes del build)

El build requiere los íconos en los formatos correctos.

### Mac — icon.icns

```bash
# Usando el icon.svg como base:
# 1. Convierte icon.svg a PNG 1024x1024 (usa Preview, Sketch, o https://svgtopng.com)
# 2. Guárdalo como assets/icon.png
# 3. Genera el .icns:

mkdir -p assets/icon.iconset

# Crea los tamaños requeridos desde icon.png (requiere sips en Mac)
sips -z 16 16     assets/icon.png --out assets/icon.iconset/icon_16x16.png
sips -z 32 32     assets/icon.png --out assets/icon.iconset/icon_16x16@2x.png
sips -z 32 32     assets/icon.png --out assets/icon.iconset/icon_32x32.png
sips -z 64 64     assets/icon.png --out assets/icon.iconset/icon_32x32@2x.png
sips -z 128 128   assets/icon.png --out assets/icon.iconset/icon_128x128.png
sips -z 256 256   assets/icon.png --out assets/icon.iconset/icon_128x128@2x.png
sips -z 256 256   assets/icon.png --out assets/icon.iconset/icon_256x256.png
sips -z 512 512   assets/icon.png --out assets/icon.iconset/icon_256x256@2x.png
sips -z 512 512   assets/icon.png --out assets/icon.iconset/icon_512x512.png
sips -z 1024 1024 assets/icon.png --out assets/icon.iconset/icon_512x512@2x.png

# Convertir a .icns
iconutil -c icns assets/icon.iconset -o assets/icon.icns
```

### Windows — icon.ico

Convierte `assets/icon.png` (512x512) a `.ico` en:
- https://convertio.co/png-ico/
- Guarda como `assets/icon.ico`

---

## Probar en desarrollo

```bash
# Prueba la app Electron sin compilar:
npm run electron
```

---

## Build para distribución

### Mac (genera .dmg)
```bash
npm run build:mac
```
Salida: `dist/TallyBridge-1.0.0.dmg` (universal: Intel + Apple Silicon)

### Windows (genera instalador .exe)
```bash
npm run build:win
```
Salida: `dist/TallyBridge Setup 1.0.0.exe`

### Ambos a la vez
```bash
npm run build:all
```

> **Nota:** Para hacer el build de Windows desde Mac necesitas Wine o correrlo en una PC con Windows.

---

## Estructura de archivos

```
tallybridge/
├── electron-main.js    ← proceso principal de Electron
├── bridge.js           ← servidor Express + lógica OBS/switcher
├── bridge-ui.html      ← interfaz de usuario
├── package.json        ← config + dependencias
├── assets/
│   ├── icon.svg        ← ícono fuente (editable)
│   ├── icon.png        ← 1024x1024 (para generar icns/ico)
│   ├── icon.icns       ← Mac (generado)
│   └── icon.ico        ← Windows (generado)
└── dist/               ← generado por electron-builder
    ├── TallyBridge-1.0.0.dmg
    └── TallyBridge Setup 1.0.0.exe
```

---

## Distribución a clientes

Sube los archivos de `dist/` a tallycomm.com para que los clientes los descarguen.
Página sugerida: `tallycomm.com/bridge`
