# Bridge OS — BLE on Windows
## Step by step, no Linux assumptions

---

## The honest situation on Windows

Windows does not expose raw Bluetooth HCI access to userspace applications the
way Linux does. `@abandonware/noble` — the BLE library Bridge OS uses — needs
that raw access. To get it on Windows you have to replace the driver on your
Bluetooth adapter with WinUSB using a tool called Zadig.

**What this means in practice:**
- If you have one Bluetooth chip (most laptops): Windows Bluetooth (headphones,
  keyboard, mouse) stops working while noble is active. You swap the driver,
  use Bridge OS BLE, swap back when you're done.
- If you plug in a cheap USB BLE dongle ($6–12 on Amazon): replace the driver
  only on the dongle. Your built-in adapter keeps working normally. This is
  the recommended approach on Windows.

---

## Option A — USB BLE dongle (recommended)

**What to buy:** Any dongle with a CSR8510, CC2540, or nRF52840 chip works.
Search Amazon for "USB Bluetooth 4.0 dongle" — the $8 ones all work.

### Step 1 — Install Zadig

Download from https://zadig.akeo.ie and run it. No install needed, it's a
single .exe.

### Step 2 — Replace the driver on the dongle only

1. Plug in your USB dongle
2. Open Zadig
3. Go to **Options → List All Devices**
4. In the dropdown, find your dongle. It will say something like
   "CSR8510 A10" or "Bluetooth USB Host Controller" or "CC2540"
5. Make sure the **right** device is selected — not your built-in Bluetooth
6. In the driver box on the right, select **WinUSB**
7. Click **Replace Driver**
8. Wait ~30 seconds

Your built-in Bluetooth still works. Only the dongle is now using WinUSB.

### Step 3 — Install Node dependencies

Open PowerShell or Command Prompt in your bridge folder:

```powershell
npm install @abandonware/noble
```

That's it on Windows — no `libbluetooth-dev` or system packages needed when
using WinUSB.

### Step 4 — Verify noble can see the adapter

```powershell
node -e "
const noble = require('@abandonware/noble');
noble.on('stateChange', state => {
  console.log('BLE adapter state:', state);
  if (state === 'poweredOn') {
    console.log('Ready. Starting scan...');
    noble.startScanning([], true);
    setTimeout(() => { noble.stopScanning(); process.exit(0); }, 3000);
  }
});
noble.on('discover', p => console.log('Found:', p.advertisement.localName, p.rssi + 'dBm'));
"
```

If you see `BLE adapter state: poweredOn` — you're done.
If you see `poweredOff` or `unsupported` — the driver swap didn't take. Reopen
Zadig and try again, making sure you selected the right device.

### Step 5 — Start Bridge OS

```powershell
node index.js
```

The transport manager auto-detects noble. If it loads, the BLE adapter shows
as available. If noble isn't found, Bridge OS falls back to HTTP — it never
fails to boot because of missing BLE.

Check from the CLI:
```
node index.js --cli
nexus@3747 ❯ status
```

---

## Option B — Built-in Bluetooth adapter (no dongle)

This works but your Windows Bluetooth (mouse, keyboard, audio) will stop
working while noble is running. Only do this if you don't use Bluetooth for
anything else.

### Step 1 — Open Zadig

Download from https://zadig.akeo.ie

### Step 2 — Replace driver on built-in adapter

1. Open Zadig → **Options → List All Devices**
2. Find "Intel Wireless Bluetooth" or "Realtek Bluetooth" or similar
3. Select **WinUSB** as the target driver
4. Click **Replace Driver**

### Step 3 — Install and test (same as Option A steps 3–5)

### To restore Windows Bluetooth later

Open **Device Manager** → **Bluetooth** → right-click your adapter →
**Update driver** → **Search automatically**. Windows will reinstall the
original driver from Windows Update.

---

## Advertising your node (so other nodes can discover you)

Noble handles scanning (finding other nodes). For advertising (making your
node visible to others), you need `bleno`. On Windows, bleno uses the same
WinUSB path:

```powershell
npm install @abandonware/bleno
```

Add to your boot code after `boot()`:

```javascript
const bleno = require('@abandonware/bleno');
const shortId = identity.uuid.slice(0, 8);

bleno.on('stateChange', state => {
  if (state === 'poweredOn') {
    bleno.startAdvertising(
      `BRIDGE:${shortId}`,
      ['6e400001b5a3f393e0a9e50e24dcca9e'],
      err => {
        if (err) console.error('[BLE] Advertising error:', err);
        else console.log(`[BLE] Advertising as BRIDGE:${shortId}`);
      }
    );
  }
});
```

Other Bridge OS nodes on the same LAN or within BLE range will discover yours
when they scan.

---

## Sending a message over BLE

Once the transport manager is running, call `transport.send()` with the peer's
HTTP address. The manager tries BLE first. If the peer is in BLE range and
advertising, it connects and sends over BLE. Otherwise it falls back to HTTP.

```javascript
const { createTransportManager } = require('./bridge-transport/index');

// After boot():
const transport = createTransportManager({ identity, busEmit });
await transport.start();

// Send — BLE if in range, HTTP fallback otherwise
const result = await transport.send('http://192.168.1.5:3747', {
  type: 'mesh:ping',
  from: identity.uuid,
});

console.log(`Sent via ${result.transport}`);
// → "Sent via ble" or "Sent via http"
```

---

## BLE limits

| Limit | Value |
|-------|-------|
| Max message size | 512 bytes |
| Chunk size | 20 bytes (ATT MTU) |
| Typical range | 10–30 metres |
| Connection time | 1–10 seconds (discovery) then ~20ms per message |

For larger payloads (mesh data, file transfer): use the IPFS content store
(`bridge-ipfs`) over HTTP. BLE in Bridge OS is for handshakes, peer discovery,
and trust code exchange — small packets where you don't have network access.

---

## Troubleshooting

**`Error: LIBUSB_ERROR_NOT_FOUND` or `no adapter found`**
→ Driver swap didn't work. Reopen Zadig, make sure you're replacing the right
  device, and try again. Sometimes you need to unplug and replug the dongle
  after the swap.

**`state: poweredOff`**
→ The adapter is recognized but not powered. If it's the built-in adapter,
  check that Bluetooth isn't disabled in Windows Settings. If it's a dongle,
  try a different USB port.

**`state: unsupported`**
→ Noble can't talk to the adapter. This usually means the WinUSB driver isn't
  active. Open Device Manager → check the dongle shows up under "Universal
  Serial Bus devices" with driver "WinUSB" — not under "Bluetooth".

**noble installed but Bridge OS still uses HTTP**
→ Check `transport/stats` endpoint. If `ble.available` is false, noble loaded
  but the adapter isn't ready. Run the verify script from Step 4 to debug.

**Windows Bluetooth stopped working after Zadig**
→ Device Manager → Bluetooth → right-click adapter → Update driver →
  Search automatically. Windows restores the original driver.

**`Error: Cannot find module '@abandonware/noble'`**
→ Run `npm install @abandonware/noble` in your bridge folder, not globally.

---

## Quick reference

```powershell
# Buy a USB BLE dongle, plug it in
# Download Zadig from zadig.akeo.ie
# Options → List All Devices → select dongle → WinUSB → Replace Driver

# In your bridge folder:
npm install @abandonware/noble

# Verify:
node -e "const n=require('@abandonware/noble'); n.on('stateChange',s=>console.log(s));"
# Should print: poweredOn

# Start Bridge OS:
node index.js

# CLI check:
node index.js --cli
nexus@3747 ❯ status
```
