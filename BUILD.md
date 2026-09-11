# TallyBridge — Instrucciones de Build

Versión de release documentada: **1.5.14**. Incluye Tally + IFB Program-Minus + Cue privado del Director.

## Requisitos

- Node.js 18+ → https://nodejs.org
- Para generar `.icns` (Mac): Xcode o herramienta `iconutil`
- Para generar `.ico` (Windows): cualquier conversor online

---

## Setup inicial

```bash
cd ~/Documents/TallyComm-Bridge
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
Salida: `dist/TallyBridge-X.Y.Z-{x64,arm64}.dmg` (un DMG por arquitectura)

### Windows (genera instalador .exe)
```bash
npm run build:win
```
Salida: `dist/TallyBridge.Setup.X.Y.Z.exe` (instalador universal x64 + ARM64)

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
    ├── TallyBridge-X.Y.Z-arm64.dmg
    ├── TallyBridge-X.Y.Z-x64.dmg
    └── TallyBridge.Setup.X.Y.Z.exe
```

---

## Distribución a clientes

El tag `vX.Y.Z` publica los archivos de `dist/` en GitHub Releases. La página
`tallycomm.com/bridge` consulta ese release y es el punto de descarga público;
no se copian binarios manualmente al servidor web.

---

## Build firmado para Mac (Developer ID + notarización)

> Requiere Apple Developer Program aprobado (vigente desde abril 2026).
> Team ID: `8922S5NL5T`

El build sin firmar abre en Mac con warning "desarrollador no identificado" + click derecho "Abrir". El build firmado + notarizado abre directo en cualquier Mac sin warnings.

### Setup (una sola vez)

1. **Generar cert "Developer ID Application"**
   - Xcode → Settings (Cmd+,) → Accounts → seleccionar Apple ID
   - Click **Manage Certificates…**
   - Click **+** (abajo izquierda) → **Developer ID Application**
   - Xcode lo importa automáticamente al login Keychain

2. **Generar App-Specific Password**
   - https://appleid.apple.com → Sign-In and Security → App-Specific Passwords
   - Click **+** → nombrar "TallyBridge notarize"
   - Copiar el password (formato `xxxx-xxxx-xxxx-xxxx`)

3. **Crear archivo de credenciales local** (no entra al repo):

```bash
cat > ~/.tallybridge-sign.env << 'EOF'
export APPLE_ID="tu-apple-id@example.com"
export APPLE_TEAM_ID="8922S5NL5T"
export APPLE_APP_SPECIFIC_PASSWORD="xxxx-xxxx-xxxx-xxxx"
EOF
chmod 600 ~/.tallybridge-sign.env
```

### Build firmado

```bash
cd ~/Documents/TallyComm-Bridge
./sign-local.sh
```

El script:
1. Valida que las env vars existan
2. Verifica que el cert esté en Keychain
3. Corre `npm run build:mac` con hardened runtime + entitlements + notarización automática via `@electron/notarize`
4. Notariza y adjunta el ticket de Apple a cada contenedor `.dmg`; además valida el ticket y el DMG antes de continuar
5. Regenera los `.blockmap` y `latest-mac.yml` **después** del stapling, para que el auto-updater publique los hashes reales
6. Notarización toma 1–3 min (Apple escanea el binario)
7. Output: `dist/TallyBridge-X.Y.Z-{x64,arm64}.dmg` firmado, notarizado y listo para publicar junto a sus `.blockmap` y `latest-mac.yml`

> Al publicar un release de macOS, sube los dos `.dmg`, sus dos `.dmg.blockmap` y `latest-mac.yml` del mismo build. No mezcles archivos de builds distintos.

### Verificar la firma

```bash
# 1. Ver que el .app interno está firmado correctamente
codesign --verify --deep --strict --verbose=2 dist/mac-arm64/TallyBridge.app

# 2. Verificar notarización + staple
spctl --assess --type exec --verbose dist/mac-arm64/TallyBridge.app
# Output esperado: "accepted" + "source=Notarized Developer ID"

# 3. Verificar que el DMG tiene el ticket stapleado
xcrun stapler validate dist/TallyBridge-1.4.0-arm64.dmg
# Output esperado: "The validate action worked!"
```

## Checklist de release

1. Incrementar `version` en `package.json` y en las dos entradas raíz de `package-lock.json`.
2. Ejecutar `node --check ifb-return.js`, `node --check ifb-cue.js` y compilar los scripts inline de `bridge-ui.html` con `new Function`.
3. Ejecutar `git diff --check` y revisar que sólo haya cambios previstos.
4. Verificar visualmente 800×600 y un viewport amplio. La pantalla mínima debe mostrar los ocho switchers y los controles completos de IFB.
5. Si cambió audio, probar Start/Stop, Program-Minus, Cue con señal real, duck y restauración. Una publicación RTP sin nivel no cuenta como audio válido.
6. Commit y push de `main`.
7. Crear y empujar el tag exacto: `git tag vX.Y.Z` y `git push origin vX.Y.Z`.
8. Esperar los jobs `build-windows`, `build-mac` y `release` del workflow `Build TallyBridge`.
9. Descargar el DMG público, validar `xcrun stapler validate`, montar y ejecutar. No validar sólo el `.app` suelto de `dist/mac-*`: el artefacto de distribución es el DMG notarizado.
10. Confirmar que GitHub Release contiene dos DMG, sus blockmaps, el instalador Windows y su blockmap, además de los metadatos del updater generados por el mismo build.

### Validación específica IFB + Cue de v1.5.14

- `RemoteAudioTrack.attach()` debe ejecutarse antes de crear el `MediaStreamAudioSourceNode`; el elemento queda muteado y sólo habilita la decodificación de Chromium/Electron.
- El estado `DIRECTOR HABLANDO` y el duck -12 dB sólo aparecen al superar el umbral RMS, no al recibir una publicación silenciosa.
- Program-Minus se publica a unity (`programGain = 1`); la consola es la autoridad de nivel.
- Al soltar Cue, el medidor vuelve a cero, Program-Minus recupera nivel y el estado vuelve a `LISTO PARA CUE DEL DIRECTOR`.
- A 800×600 no debe haber scroll para alcanzar `INICIAR RUTA IFB`, `REFRESCAR TALENT` ni `DETENER RUTA`.

### Windows signing (diferido)

Windows NO está incluido en Apple Developer Program. Requiere Code Signing Certificate de CA externo (DigiCert, Sectigo, etc — $200-500/año). Sin eso el `.exe` muestra SmartScreen "Unknown publisher" pero funciona. Agregar cuando haya demanda real de usuarios Windows.
