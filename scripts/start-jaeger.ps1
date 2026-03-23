# Jaeger all-in-one as binary (no Docker required)
$jaegerDir = "$PSScriptRoot\..\tools\jaeger"
$jaegerBin = "$jaegerDir\jaeger-all-in-one.exe"

# Ensure tools directory exists
if (-not (Test-Path $jaegerDir)) {
    New-Item -ItemType Directory -Path $jaegerDir -Force | Out-Null
}

# Download and extract Jaeger if not present
if (-not (Test-Path $jaegerBin)) {
    $zipFile = Join-Path $jaegerDir "jaeger.zip"
    
    if (-not (Test-Path $zipFile)) {
        Write-Host "Downloading Jaeger all-in-one binary..."
        $downloadUrl = "https://github.com/jaegertracing/jaeger/releases/download/v2.16.0/jaeger-2.16.0-windows-amd64.zip"
        
        try {
            Invoke-WebRequest -Uri $downloadUrl -OutFile $zipFile -ErrorAction Stop
            Write-Host "Downloaded to $zipFile"
        } catch {
            Write-Host "Auto-download failed. Please download manually:"
            Write-Host "1. Visit: https://github.com/jaegertracing/jaeger/releases"
            Write-Host "2. Download: jaeger-X.X.X-windows-amd64.zip"
            Write-Host "3. Extract to: $jaegerDir"
            exit 1
        }
    }
    
    Write-Host "Extracting..."
    Expand-Archive -Path $zipFile -DestinationPath $jaegerDir -Force
    
    # Find the extracted executable and move it to root level
    $extracted = Get-ChildItem -Path $jaegerDir -Directory | Where-Object { $_.Name -like "jaeger-*" } | Select-Object -First 1
    if ($extracted) {
        $srcBin = Join-Path $extracted.FullName "jaeger.exe"
        if (Test-Path $srcBin) {
            Copy-Item -Path $srcBin -Destination $jaegerBin -Force
            Write-Host "Ready: $jaegerBin"
        } else {
            Write-Error "Could not find jaeger.exe in extracted archive at $srcBin"
            exit 1
        }
    } else {
        Write-Error "Could not find extracted jaeger directory"
        exit 1
    }
}

# Launch Jaeger (OTLP receiver is enabled by default in v2.16+)
Write-Host "Starting Jaeger all-in-one..."
Write-Host ""
& $jaegerBin

Write-Host ""
Write-Host "Jaeger UI: http://localhost:16686"
Write-Host "OTLP traces endpoint: http://localhost:4318/v1/traces"
Write-Host ""
Write-Host "Close this terminal to stop Jaeger."