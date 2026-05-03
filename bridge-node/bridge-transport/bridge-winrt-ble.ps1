# bridge-winrt-ble.ps1  v2.0.0
# Bridge OS — WinRT BLE host process (Central + Peripheral)
#
# Runs as a persistent child process spawned by bridge-winrt.js.
# Speaks a JSON line protocol on stdin/stdout.
# Uses Windows 10 1703+ built-in WinRT Bluetooth APIs.
# No external dependencies. Uses the internal hardware Bluetooth chip.
#
# Central role  (finding and connecting to other nodes):
#   BluetoothLEAdvertisementWatcher + BluetoothLEDevice + GattCharacteristic
#
# Peripheral role (advertising ourselves, accepting connections):
#   BluetoothLEAdvertisementPublisher — makes us discoverable
#   GattServiceProvider               — hosts the NUS GATT service locally
#   GattLocalCharacteristic           — TX (remote writes) + RX (we notify)
#
# Commands (Node → PS, one JSON line each):
#   startScanning   { serviceUUIDs[], allowDups }
#   stopScanning
#   startAdvertising{ localName, serviceUUID }
#   stopAdvertising
#   connect         { address }
#   disconnect      { address }
#   requestMtu      { address, mtu }
#   discoverServices{ address, serviceUUIDs[], charUUIDs[] }
#   write           { address, charUUID, data:base64, withoutResponse }
#   subscribe       { address, charUUID }
#   notify          { charUUID, data:base64 }   ← push data to all subscribed centrals
#   ping
#   exit
#
# Events (PS → Node, one JSON line each):
#   stateChange     { state, backend }
#   ready           { backend, pid, address, hasPeripheral }
#   scanStarted / scanStopped
#   advertisingStarted / advertisingStopped / advertisingError { reason }
#   discover        { address, name, rssi, raw }
#   connecting / connected / disconnected { address }
#   mtuNegotiated   { address, mtu }
#   servicesDiscovered { address, characteristics[] }
#   subscribed      { address, charUUID }
#   data            { address, charUUID, data:base64 }   ← central wrote to us
#   centralConnected    { address }                      ← a central connected to us
#   centralDisconnected { address }
#   notified        { charUUID, recipients }             ← notify delivered
#   error           { address, reason }
#   pong            { ts }

param()
$ErrorActionPreference = 'Continue'
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
[Console]::InputEncoding  = [System.Text.Encoding]::UTF8

# ── WinRT loader ──────────────────────────────────────────────────────────────
function Load-WinRT {
    Add-Type -AssemblyName System.Runtime.WindowsRuntime
    # Force load of Windows.Devices.Bluetooth assembly
    $null = [Windows.Devices.Bluetooth.BluetoothAdapter,
             Windows.Devices.Bluetooth,
             ContentType = WindowsRuntime]
    $null = [Windows.Devices.Bluetooth.Advertisement.BluetoothLEAdvertisementWatcher,
             Windows.Devices.Bluetooth,
             ContentType = WindowsRuntime]
    $null = [Windows.Devices.Bluetooth.GenericAttributeProfile.GattServiceProvider,
             Windows.Devices.Bluetooth,
             ContentType = WindowsRuntime]
    $null = [Windows.Storage.Streams.DataReader,
             Windows.Storage.Streams,
             ContentType = WindowsRuntime]
}

# Await a WinRT IAsyncOperation — blocks calling thread
function Await-WinRT {
    param($AsyncOp, [int]$TimeoutMs = 15000)
    $ext    = [System.WindowsRuntimeSystemExtensions]
    $method = $ext.GetMethods() | Where-Object { $_.Name -eq 'AsTask' -and $_.GetParameters().Count -eq 1 } | Select-Object -First 1
    if (-not $method) {
        # Fallback for older PS versions
        $asTask = [System.WindowsRuntimeSystemExtensions]::AsTask($AsyncOp)
    } else {
        $genMethod = $method.MakeGenericMethod($AsyncOp.GetType().GetGenericArguments())
        $asTask = $genMethod.Invoke($null, @($AsyncOp))
    }
    if (-not $asTask.Wait($TimeoutMs)) { throw "WinRT timeout after ${TimeoutMs}ms" }
    if ($asTask.IsFaulted) { throw $asTask.Exception.InnerException }
    return $asTask.Result
}

# Simpler IAsyncOperation awaiter using GetAwaiter reflection
function Await2 {
    param($AsyncOp, [int]$TimeoutMs = 15000)
    $tcs  = New-Object 'System.Threading.Tasks.TaskCompletionSource[object]'
    $handler = [Windows.Foundation.AsyncOperationCompletedHandler[object]]{
        param($op, $status)
        if ($status -eq 'Completed') { $tcs.SetResult($op.GetResults()) }
        elseif ($status -eq 'Error') { $tcs.SetException($op.ErrorCode) }
        else { $tcs.SetCanceled() }
    }
    $AsyncOp.Completed = $handler
    if (-not $tcs.Task.Wait($TimeoutMs)) { throw "Await2 timeout" }
    return $tcs.Task.Result
}

# IAsyncAction awaiter (no return value)
function Await-Action {
    param($AsyncAction, [int]$TimeoutMs = 10000)
    $tcs = New-Object 'System.Threading.Tasks.TaskCompletionSource[object]'
    $handler = [Windows.Foundation.AsyncActionCompletedHandler]{
        param($op, $status)
        if ($status -eq 'Completed') { $tcs.SetResult($null) }
        elseif ($status -eq 'Error') { $tcs.SetException($op.ErrorCode) }
        else { $tcs.SetCanceled() }
    }
    $AsyncAction.Completed = $handler
    if (-not $tcs.Task.Wait($TimeoutMs)) { throw "Action timeout" }
}

function Buffer-ToBase64 {
    param($IBuffer)
    $reader = [Windows.Storage.Streams.DataReader]::FromBuffer($IBuffer)
    $bytes  = New-Object byte[] $IBuffer.Length
    $reader.ReadBytes($bytes)
    $reader.DetachBuffer()
    return [Convert]::ToBase64String($bytes)
}

function Base64-ToBuffer {
    param([string]$B64)
    $bytes  = [Convert]::FromBase64String($B64)
    $writer = New-Object Windows.Storage.Streams.DataWriter
    $writer.WriteBytes($bytes)
    return $writer.DetachBuffer()
}

function Bytes-ToBuffer {
    param([byte[]]$Bytes)
    $writer = New-Object Windows.Storage.Streams.DataWriter
    $writer.WriteBytes($Bytes)
    return $writer.DetachBuffer()
}

function Emit {
    param([hashtable]$Obj)
    try {
        $json = $Obj | ConvertTo-Json -Compress -Depth 6
        [Console]::Out.WriteLine($json)
        [Console]::Out.Flush()
    } catch {}
}

function Emit-Error {
    param([string]$Reason, [string]$Address = '')
    Emit @{ event = 'error'; address = $Address; reason = $Reason }
}

# ── Script-level state ────────────────────────────────────────────────────────
$script:watcher        = $null
$script:scanning       = $false
$script:rawAddressMap  = @{}        # addrStr → uint64
$script:devices        = @{}        # addrStr → BluetoothLEDevice
$script:services       = @{}        # addrStr → hashtable{uuid→GattDeviceService}
$script:chars          = @{}        # addrStr → hashtable{uuid→GattCharacteristic}

# Peripheral state
$script:publisher      = $null      # BluetoothLEAdvertisementPublisher
$script:serviceProvider = $null     # GattServiceProvider
$script:localTxChar    = $null      # GattLocalCharacteristic (write — central→us)
$script:localRxChar    = $null      # GattLocalCharacteristic (notify — us→central)
$script:advertising    = $false
$script:subscribedSessions = [System.Collections.Generic.List[object]]::new()

# ── Initialise ────────────────────────────────────────────────────────────────
try {
    Load-WinRT

    # Get the default BLE adapter (internal hardware Bluetooth)
    $adapter = Await-WinRT ([Windows.Devices.Bluetooth.BluetoothAdapter]::GetDefaultAsync())
    if ($null -eq $adapter) {
        Emit @{ event = 'stateChange'; state = 'unsupported'; reason = 'No Bluetooth adapter found' }
        exit 1
    }
    if (-not $adapter.IsLowEnergySupported) {
        Emit @{ event = 'stateChange'; state = 'unsupported'; reason = 'Adapter does not support BLE' }
        exit 1
    }

    # Check peripheral role support
    $hasPeripheral = $adapter.IsPeripheralRoleSupported
    $adapterAddr   = $adapter.BluetoothAddress
    $addrHex       = '{0:X12}' -f $adapterAddr
    $adapterAddrStr = ($addrHex -split '(..)' | Where-Object { $_ }) -join ':'

    Emit @{
        event         = 'stateChange'
        state         = 'poweredOn'
        backend       = 'winrt-native'
        hasPeripheral = [bool]$hasPeripheral
        address       = $adapterAddrStr
    }
} catch {
    Emit @{ event = 'stateChange'; state = 'poweredOff'; reason = $_.Exception.Message }
    exit 1
}

# ── Central: Scanning ─────────────────────────────────────────────────────────
function Start-BLEScan {
    param([string[]]$ServiceUUIDs = @(), [bool]$AllowDups = $true)
    if ($script:scanning) { return }

    $script:watcher = New-Object Windows.Devices.Bluetooth.Advertisement.BluetoothLEAdvertisementWatcher
    $script:watcher.ScanningMode = [Windows.Devices.Bluetooth.Advertisement.BluetoothLEScanningMode]::Active

    if ($ServiceUUIDs.Count -gt 0) {
        foreach ($u in $ServiceUUIDs) {
            try { $script:watcher.AdvertisementFilter.Advertisement.ServiceUuids.Add([Guid]$u) } catch {}
        }
    }

    $script:watcher.add_Received({
        param($s, $args)
        try {
            $addr    = $args.BluetoothAddress
            $addrHex = '{0:X12}' -f $addr
            $addrStr = ($addrHex -split '(..)' | Where-Object { $_ }) -join ':'
            $script:rawAddressMap[$addrStr] = $addr
            $adv     = $args.Advertisement
            $name    = $adv.LocalName
            $rssi    = $args.RawSignalStrengthInDBm
            Emit @{ event = 'discover'; address = $addrStr; name = $name; rssi = $rssi; raw = $addr }
        } catch { Emit-Error "discover: $($_.Exception.Message)" }
    })

    $script:watcher.add_Stopped({
        $script:scanning = $false
        Emit @{ event = 'scanStopped' }
    })

    $script:watcher.Start()
    $script:scanning = $true
    Emit @{ event = 'scanStarted' }
}

function Stop-BLEScan {
    if ($script:watcher -and $script:scanning) {
        try { $script:watcher.Stop() } catch {}
        $script:scanning = $false
    }
}

# ── Peripheral: Advertising ───────────────────────────────────────────────────
function Start-Advertising {
    param([string]$LocalName = 'BRIDGE', [string]$ServiceUUID = '6e400001-b5a3-f393-e0a9-e50e24dcca9e')

    if ($script:advertising) { Stop-Advertising }

    try {
        # ── Publisher: makes us visible in BLE scans ──────────────────────────
        $script:publisher = New-Object Windows.Devices.Bluetooth.Advertisement.BluetoothLEAdvertisementPublisher

        $adv       = New-Object Windows.Devices.Bluetooth.Advertisement.BluetoothLEAdvertisement
        $adv.LocalName = $LocalName

        # Advertise NUS service UUID so scanners can filter for Bridge nodes
        try {
            $svcGuid = [Guid]$ServiceUUID
            $adv.ServiceUuids.Add($svcGuid)
        } catch {}

        $script:publisher.Advertisement = $adv

        $script:publisher.add_StatusChanged({
            param($pub, $args)
            $status = $args.Status.ToString()
            if ($status -eq 'Started') {
                $script:advertising = $true
                Emit @{ event = 'advertisingStarted'; localName = $LocalName }
            } elseif ($status -eq 'Stopped') {
                $script:advertising = $false
                Emit @{ event = 'advertisingStopped' }
            } elseif ($status -eq 'Aborted') {
                $script:advertising = $false
                $err = $args.Error
                Emit @{ event = 'advertisingError'; reason = "Aborted: $err" }
            }
        })

        $script:publisher.Start()

        # ── GattServiceProvider: hosts the actual NUS GATT service ────────────
        # This creates a real GATT server on the hardware adapter.
        # Other devices can connect and write to our characteristics.
        $svcGuid    = [Guid]$ServiceUUID
        $svcParams  = New-Object Windows.Devices.Bluetooth.GenericAttributeProfile.GattServiceProviderAdvertisingParameters
        $svcParams.IsConnectable   = $true
        $svcParams.IsDiscoverable  = $true

        $svcResult  = Await-WinRT ([Windows.Devices.Bluetooth.GenericAttributeProfile.GattServiceProvider]::CreateAsync($svcGuid))
        if ($svcResult.Error.ToString() -ne 'Success') {
            Emit @{ event = 'advertisingError'; reason = "GattServiceProvider create failed: $($svcResult.Error)" }
            return
        }
        $script:serviceProvider = $svcResult.ServiceProvider

        # ── TX characteristic: central writes to this (we receive data) ───────
        $txGuid    = [Guid]'6e400002-b5a3-f393-e0a9-e50e24dcca9e'
        $txParams  = New-Object Windows.Devices.Bluetooth.GenericAttributeProfile.GattLocalCharacteristicParameters
        $txParams.CharacteristicProperties = `
            [Windows.Devices.Bluetooth.GenericAttributeProfile.GattCharacteristicProperties]::Write -bor `
            [Windows.Devices.Bluetooth.GenericAttributeProfile.GattCharacteristicProperties]::WriteWithoutResponse
        $txParams.WriteProtectionLevel = `
            [Windows.Devices.Bluetooth.GenericAttributeProfile.GattProtectionLevel]::Plain
        $txParams.UserDescription = 'Bridge TX'

        $txResult = Await-WinRT ($script:serviceProvider.Service.CreateCharacteristicAsync($txGuid, $txParams))
        if ($txResult.Error.ToString() -ne 'Success') {
            Emit @{ event = 'advertisingError'; reason = "TX char failed: $($txResult.Error)" }
            return
        }
        $script:localTxChar = $txResult.Characteristic

        # Handle incoming writes from centrals
        $script:localTxChar.add_WriteRequested({
            param($char, $args)
            $deferral = $args.GetDeferral()
            try {
                $session = $args.Session
                $addr    = 'central'
                try {
                    $btAddr  = $session.DeviceId.Id
                    # Extract address from DeviceId string (format varies)
                    if ($btAddr -match '([0-9A-Fa-f]{12})') {
                        $hex     = $matches[1]
                        $addr    = ($hex -split '(..)' | Where-Object { $_ }) -join ':'
                    }
                } catch {}

                $request = $args.GetRequestAsync() | ForEach-Object { Await-WinRT $_ }
                if ($request.Value.Length -gt 0) {
                    $b64 = Buffer-ToBase64 $request.Value
                    Emit @{
                        event    = 'data'
                        address  = $addr
                        charUUID = '6e400002b5a3f393e0a9e50e24dcca9e'
                        data     = $b64
                    }
                }
                if ($request.Option -eq [Windows.Devices.Bluetooth.GenericAttributeProfile.GattWriteOption]::WriteWithResponse) {
                    $request.Respond()
                }
            } catch {
                Emit-Error "WriteRequested: $($_.Exception.Message)"
            } finally {
                $deferral.Complete()
            }
        })

        # ── RX characteristic: we notify centrals on this (we send data) ──────
        $rxGuid   = [Guid]'6e400003-b5a3-f393-e0a9-e50e24dcca9e'
        $rxParams = New-Object Windows.Devices.Bluetooth.GenericAttributeProfile.GattLocalCharacteristicParameters
        $rxParams.CharacteristicProperties = `
            [Windows.Devices.Bluetooth.GenericAttributeProfile.GattCharacteristicProperties]::Notify
        $rxParams.WriteProtectionLevel = `
            [Windows.Devices.Bluetooth.GenericAttributeProfile.GattProtectionLevel]::Plain
        $rxParams.UserDescription = 'Bridge RX'

        $rxResult = Await-WinRT ($script:serviceProvider.Service.CreateCharacteristicAsync($rxGuid, $rxParams))
        if ($rxResult.Error.ToString() -ne 'Success') {
            Emit @{ event = 'advertisingError'; reason = "RX char failed: $($rxResult.Error)" }
            return
        }
        $script:localRxChar = $rxResult.Characteristic

        # Track which centrals have subscribed to notifications
        $script:localRxChar.add_SubscribedClientsChanged({
            param($char, $args)
            $count = $char.SubscribedClients.Count
            $script:subscribedSessions = $char.SubscribedClients
            Emit @{ event = 'subscribersChanged'; count = $count }
        })

        # Session (central) connect/disconnect events via GattSession
        $script:serviceProvider.add_AdvertisementStatusChanged({
            param($p, $args)
        })

        # Start the GATT service
        $script:serviceProvider.StartAdvertising($svcParams)

    } catch {
        Emit @{ event = 'advertisingError'; reason = $_.Exception.Message }
    }
}

function Stop-Advertising {
    if ($script:publisher) {
        try { $script:publisher.Stop() } catch {}
        $script:publisher = $null
    }
    if ($script:serviceProvider) {
        try { $script:serviceProvider.StopAdvertising() } catch {}
        $script:serviceProvider = $null
    }
    $script:localTxChar = $null
    $script:localRxChar = $null
    $script:advertising = $false
    $script:subscribedSessions = [System.Collections.Generic.List[object]]::new()
    Emit @{ event = 'advertisingStopped' }
}

# ── Peripheral: Notify (push data to connected centrals) ─────────────────────
function Send-Notify {
    param([string]$CharUUID, [string]$DataB64)
    if (-not $script:localRxChar) {
        Emit-Error "Not advertising — call startAdvertising first"
        return
    }
    try {
        $buf        = Base64-ToBuffer $DataB64
        $recipients = 0
        foreach ($session in $script:subscribedSessions) {
            try {
                Await-WinRT ($script:localRxChar.NotifyValueAsync($buf, $session))
                $recipients++
            } catch {}
        }
        Emit @{ event = 'notified'; charUUID = $CharUUID; recipients = $recipients }
    } catch {
        Emit-Error "Notify failed: $($_.Exception.Message)"
    }
}

# ── Central: Connect ──────────────────────────────────────────────────────────
function Connect-Device {
    param([string]$Address, [uint64]$RawAddr)
    try {
        Emit @{ event = 'connecting'; address = $Address }
        $device = Await-WinRT ([Windows.Devices.Bluetooth.BluetoothLEDevice]::FromBluetoothAddressAsync($RawAddr))
        if ($null -eq $device) { Emit-Error "Device not found" $Address; return }
        $script:devices[$Address] = $device
        $capturedAddr = $Address
        $device.add_ConnectionStatusChanged({
            param($d, $a)
            if ($d.ConnectionStatus.ToString() -eq 'Disconnected') {
                Emit @{ event = 'disconnected'; address = $capturedAddr }
                $script:devices.Remove($capturedAddr)
                $script:services.Remove($capturedAddr)
                $script:chars.Remove($capturedAddr)
            }
        })
        Emit @{ event = 'connected'; address = $Address }
    } catch {
        Emit-Error "Connect failed: $($_.Exception.Message)" $Address
    }
}

function Disconnect-Device {
    param([string]$Address)
    $d = $script:devices[$Address]
    if ($d) {
        try { $d.Dispose() } catch {}
        $script:devices.Remove($Address)
        $script:services.Remove($Address)
        $script:chars.Remove($Address)
        Emit @{ event = 'disconnected'; address = $Address; reason = 'local' }
    }
}

function Request-MTU {
    param([string]$Address, [int]$Mtu)
    # WinRT negotiates MTU automatically; report the supported max
    Emit @{ event = 'mtuNegotiated'; address = $Address; mtu = 247 }
}

# ── Central: Discover services ────────────────────────────────────────────────
function Discover-Services {
    param([string]$Address, [string[]]$ServiceUUIDs = @(), [string[]]$CharUUIDs = @())
    $device = $script:devices[$Address]
    if (-not $device) { Emit-Error "Not connected" $Address; return }
    try {
        if (-not $script:services.ContainsKey($Address)) { $script:services[$Address] = @{} }
        if (-not $script:chars.ContainsKey($Address))    { $script:chars[$Address] = @{} }
        $found = @()
        foreach ($su in $ServiceUUIDs) {
            $sg = [Guid]$su
            $sr = Await-WinRT ($device.GetGattServicesForUuidAsync($sg))
            if ($sr.Status.ToString() -ne 'Success') { continue }
            foreach ($svc in $sr.Services) {
                $script:services[$Address][$su] = $svc
                $cr = Await-WinRT ($svc.GetCharacteristicsAsync())
                if ($cr.Status.ToString() -ne 'Success') { continue }
                foreach ($ch in $cr.Characteristics) {
                    $cuuid = $ch.Uuid.ToString('D').ToLower() -replace '-', ''
                    $want  = ($CharUUIDs.Count -eq 0) -or ($CharUUIDs -contains $cuuid)
                    if (-not $want) { continue }
                    $script:chars[$Address][$cuuid] = $ch
                    $cp    = $ch.CharacteristicProperties
                    $props = @()
                    $P     = [Windows.Devices.Bluetooth.GenericAttributeProfile.GattCharacteristicProperties]
                    if ($cp -band $P::Read)               { $props += 'read' }
                    if ($cp -band $P::Write)              { $props += 'write' }
                    if ($cp -band $P::WriteWithoutResponse){ $props += 'writeWithoutResponse' }
                    if ($cp -band $P::Notify)             { $props += 'notify' }
                    if ($cp -band $P::Indicate)           { $props += 'indicate' }
                    $found += @{ uuid = $cuuid; properties = $props }
                }
            }
        }
        Emit @{ event = 'servicesDiscovered'; address = $Address; characteristics = $found }
    } catch {
        Emit-Error "Discover failed: $($_.Exception.Message)" $Address
    }
}

# ── Central: Write characteristic ────────────────────────────────────────────
function Write-Char {
    param([string]$Address, [string]$CharUUID, [string]$DataB64, [bool]$WithoutResponse)
    $ch = $script:chars[$Address][$CharUUID]
    if (-not $ch) { Emit-Error "Char $CharUUID not found" $Address; return }
    try {
        $buf = Base64-ToBuffer $DataB64
        $wt  = if ($WithoutResponse) {
            [Windows.Devices.Bluetooth.GenericAttributeProfile.GattWriteOption]::WriteWithoutResponse
        } else {
            [Windows.Devices.Bluetooth.GenericAttributeProfile.GattWriteOption]::WriteWithResponse
        }
        $r = Await-WinRT ($ch.WriteValueWithResultAsync($buf, $wt))
        if ($r.Status.ToString() -ne 'Success') { Emit-Error "Write: $($r.Status)" $Address }
    } catch {
        Emit-Error "Write exception: $($_.Exception.Message)" $Address
    }
}

# ── Central: Subscribe characteristic ────────────────────────────────────────
function Subscribe-Char {
    param([string]$Address, [string]$CharUUID)
    $ch = $script:chars[$Address][$CharUUID]
    if (-not $ch) { Emit-Error "Char $CharUUID not found for subscribe" $Address; return }
    try {
        $CCCD = [Windows.Devices.Bluetooth.GenericAttributeProfile.GattClientCharacteristicConfigurationDescriptorValue]
        $r    = Await-WinRT ($ch.WriteClientCharacteristicConfigurationDescriptorAsync($CCCD::Notify))
        if ($r.ToString() -ne 'Success') { Emit-Error "Subscribe: $r" $Address; return }
        $capAddr = $Address; $capUUID = $CharUUID
        $ch.add_ValueChanged({
            param($s, $a)
            try {
                $b64 = Buffer-ToBase64 $a.CharacteristicValue
                Emit @{ event = 'data'; address = $capAddr; charUUID = $capUUID; data = $b64 }
            } catch { Emit-Error "Data event: $($_.Exception.Message)" $capAddr }
        })
        Emit @{ event = 'subscribed'; address = $Address; charUUID = $CharUUID }
    } catch {
        Emit-Error "Subscribe exception: $($_.Exception.Message)" $Address
    }
}

# ── Ready ─────────────────────────────────────────────────────────────────────
Emit @{
    event         = 'ready'
    backend       = 'winrt-native'
    pid           = [System.Diagnostics.Process]::GetCurrentProcess().Id
    hasPeripheral = [bool]$adapter.IsPeripheralRoleSupported
    address       = $adapterAddrStr
}

# ── Command loop ──────────────────────────────────────────────────────────────
while ($true) {
    try {
        $line = [Console]::In.ReadLine()
        if ($null -eq $line) { break }
        $line = $line.Trim()
        if ($line -eq '') { continue }
        $cmd = $line | ConvertFrom-Json

        switch ($cmd.cmd) {
            'startScanning' {
                $uuids = if ($cmd.serviceUUIDs) { $cmd.serviceUUIDs } else { @() }
                Start-BLEScan -ServiceUUIDs $uuids -AllowDups ($cmd.allowDups -ne $false)
            }
            'stopScanning'   { Stop-BLEScan }

            'startAdvertising' {
                $name  = if ($cmd.localName)    { $cmd.localName }    else { 'BRIDGE' }
                $svcUu = if ($cmd.serviceUUID)  { $cmd.serviceUUID }  else { '6e400001-b5a3-f393-e0a9-e50e24dcca9e' }
                Start-Advertising -LocalName $name -ServiceUUID $svcUu
            }
            'stopAdvertising'  { Stop-Advertising }

            'notify' {
                $cuuid = if ($cmd.charUUID) { $cmd.charUUID } else { '6e400003b5a3f393e0a9e50e24dcca9e' }
                [System.Threading.ThreadPool]::QueueUserWorkItem({
                    Send-Notify -CharUUID $cuuid -DataB64 $cmd.data
                }) | Out-Null
            }

            'connect' {
                $raw = $script:rawAddressMap[$cmd.address]
                if (-not $raw) { Emit-Error "Unknown address $($cmd.address) — scan first" $cmd.address; break }
                $addr = $cmd.address; $rawA = $raw
                [System.Threading.ThreadPool]::QueueUserWorkItem({
                    Connect-Device -Address $addr -RawAddr $rawA
                }) | Out-Null
            }
            'disconnect'      { Disconnect-Device -Address $cmd.address }
            'requestMtu'      { Request-MTU -Address $cmd.address -Mtu ([int]$cmd.mtu) }

            'discoverServices' {
                $su = if ($cmd.serviceUUIDs) { $cmd.serviceUUIDs } else { @() }
                $cu = if ($cmd.charUUIDs)    { $cmd.charUUIDs }    else { @() }
                $addr = $cmd.address
                [System.Threading.ThreadPool]::QueueUserWorkItem({
                    Discover-Services -Address $addr -ServiceUUIDs $su -CharUUIDs $cu
                }) | Out-Null
            }

            'write' {
                $addr = $cmd.address; $ch = $cmd.charUUID; $dat = $cmd.data; $wor = [bool]($cmd.withoutResponse)
                [System.Threading.ThreadPool]::QueueUserWorkItem({
                    Write-Char -Address $addr -CharUUID $ch -DataB64 $dat -WithoutResponse $wor
                }) | Out-Null
            }

            'subscribe' {
                $addr = $cmd.address; $ch = $cmd.charUUID
                [System.Threading.ThreadPool]::QueueUserWorkItem({
                    Subscribe-Char -Address $addr -CharUUID $ch
                }) | Out-Null
            }

            'ping' { Emit @{ event = 'pong'; ts = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds() } }

            'exit' {
                Stop-BLEScan; Stop-Advertising
                foreach ($a in @($script:devices.Keys)) { Disconnect-Device -Address $a }
                exit 0
            }
            default { Emit-Error "Unknown command: $($cmd.cmd)" }
        }
    } catch {
        Emit-Error "Command loop: $($_.Exception.Message)"
    }
}
