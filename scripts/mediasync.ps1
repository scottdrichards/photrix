<#
MediaSync.ps1
- Syncs new/changed files from a source UNC to a destination (e.g., Z:\) using a local manifest
- Avoids destination-wide scans to minimize Azure Files transactions
- Uses robocopy /Z so large files can resume
- Stores manifest and logs under %ProgramData%\MediaSync\

USAGE:
  powershell.exe -ExecutionPolicy Bypass -File .\MediaSync.ps1 `
    -SourceRoot "\\TRUENAS\Pictures and Videos READONLY" `
    -DestRoot "Z:\"

PARAMETERS:
  -SourceRoot : Root of the source tree (UNC or local path)
  -DestRoot   : Destination root (e.g., Z:\ or \\server\share\folder\)
  -MaxThreads : Robocopy /MT value (default 4 for low SMB transaction overhead)
  -ExitOnNoDelta : If set, exits with code 0 immediately if nothing to copy
#>

[CmdletBinding()]
param(
  [Parameter(Mandatory = $false)]
  [string]$SourceRoot = "\\TRUENAS\Pictures and Videos READONLY",

  [Parameter(Mandatory = $false)]
  [string]$DestRoot = "Z:\",

  [Parameter(Mandatory = $false)]
  [ValidateRange(1, 128)]
  [int]$MaxThreads = 4,

  [switch]$ExitOnNoDelta
)

$ErrorActionPreference = "Stop"

# ---------------- Internals (paths, setup) ----------------
$ProgramDataRoot = Join-Path $env:ProgramData "MediaSync"
$StateDir        = Join-Path $ProgramDataRoot "State"
$LogDir          = Join-Path $ProgramDataRoot "Logs"
$ManifestPath    = Join-Path $StateDir "manifest_pictures.csv"
$ListFilePath    = Join-Path $StateDir "robocopy_list.txt"
$LogPath         = Join-Path $LogDir "robocopy_pics_azure.log"
$TranscriptPath  = Join-Path $LogDir ("transcript_{0:yyyyMMdd_HHmmss}.log" -f (Get-Date))

foreach ($d in @($ProgramDataRoot, $StateDir, $LogDir)) {
  if (-not (Test-Path $d)) { New-Item -ItemType Directory -Path $d -Force | Out-Null }
}

Start-Transcript -Path $TranscriptPath -Append | Out-Null

function Write-Info($msg) { Write-Host "[INFO ] $msg" -ForegroundColor Cyan }
function Write-Warn($msg) { Write-Warning $msg }
function Write-Err ($msg) { Write-Error $msg }

# Normalize and validate paths
function Normalize-Root([string]$p) {
  if (-not $p) { throw "Path is empty." }
  # Ensure it ends with backslash for relative calc
  if ($p[-1] -ne '\\') { return $p + '\\' } else { return $p }
}

try {
  $SourceRoot = Normalize-Root $SourceRoot
  $DestRoot   = Normalize-Root $DestRoot

  # Validate reachability early
  Write-Info "Source root : $SourceRoot"
  Write-Info "Dest root   : $DestRoot"

  if (-not (Test-Path -LiteralPath $SourceRoot)) {
    Stop-Transcript | Out-Null
    throw "Source path is not reachable: $SourceRoot. Check UNC permissions/connectivity."
  }

  # We do not Test-Path the destination to avoid triggering an unnecessary list;
  # robocopy will create needed dirs on demand.
}
catch {
  Write-Err $_.Exception.Message
  exit 1
}

# Attempt to resolve (for prettier logs); if UNC cannot be resolved, continue anyway.
try {
  $SourceRootResolved = (Resolve-Path -LiteralPath $SourceRoot).Path
} catch {
  $SourceRootResolved = $SourceRoot
}
Write-Info "Scanning source (this does not touch destination)..."
$srcFiles = Get-ChildItem -LiteralPath $SourceRootResolved -Recurse -File -Force -ErrorAction SilentlyContinue
Write-Info ("Source file count: {0}" -f ($srcFiles.Count))

# ---------------- Manifest load ----------------
$manifest = @{}
if (Test-Path $ManifestPath) {
  Write-Info "Loading manifest: $ManifestPath"
  try {
    Import-Csv $ManifestPath | ForEach-Object {
      $manifest[$_.Path.ToLowerInvariant()] = $_
    }
  } catch {
    Write-Warn "Manifest is unreadable. Starting fresh. Error: $($_.Exception.Message)"
  }
} else {
  Write-Info "No manifest found. A new one will be created after copy."
}

# ---------------- Build delta from source only ----------------
# Helper: stable relative path
function Get-RelativePath {
  param(
    [string]$FullPath,
    [string]$Root1,     # primary (as provided)
    [string]$Root2      # resolved (fallback)
  )
  $lcFull = $FullPath.ToLowerInvariant()
  $lcR1   = $Root1.ToLowerInvariant()
  $lcR2   = $Root2.ToLowerInvariant()

  if ($lcFull.StartsWith($lcR1)) {
    return $FullPath.Substring($Root1.Length).TrimStart('\\')
  }
  if ($lcFull.StartsWith($lcR2)) {
    return $FullPath.Substring($Root2.Length).TrimStart('\\')
  }
  return $null
}

$delta = foreach ($f in $srcFiles) {
  $rel = Get-RelativePath -FullPath $f.FullName -Root1 $SourceRoot -Root2 $SourceRootResolved
  if (-not $rel) {
    Write-Warn "Could not compute relative path for: $($f.FullName)"
    continue
  }

  $key = $rel.ToLowerInvariant()
  $len = [int64]$f.Length
  $tsU = $f.LastWriteTimeUtc.ToString('o')  # ISO 8601

  if (-not $manifest.ContainsKey($key)) {
    [pscustomobject]@{ Path=$rel; Length=$len; LastWriteTimeUtc=$tsU }
  } else {
    $m = $manifest[$key]
    if ( ([int64]$m.Length -ne $len) -or ($m.LastWriteTimeUtc -ne $tsU) ) {
      [pscustomobject]@{ Path=$rel; Length=$len; LastWriteTimeUtc=$tsU }
    }
  }
}

$deltaList = $delta | Sort-Object Path
$deltaCount = ($deltaList | Measure-Object).Count

if ($deltaCount -eq 0) {
  Write-Info "Nothing new or changed. Exiting."
  Stop-Transcript | Out-Null
  if ($ExitOnNoDelta) { exit 0 } else { return }
}

Write-Info ("Files to copy (candidate list): {0}" -f $deltaCount)

# ---------------- Write list for robocopy ----------------
$null = New-Item -ItemType File -Path $ListFilePath -Force
$deltaList.Path | Set-Content -Path $ListFilePath -Encoding UTF8

# ---------------- Robocopy (minimal Azure calls) ----------------
# Build args as a string array to preserve tokens reliably with Start-Process.
$listToken = '@' + $ListFilePath
[string[]]$roboArgs = @(
  $SourceRoot,                 # e.g., \\TRUENAS\Pictures and Videos READONLY\
  $DestRoot,                   # e.g., Z:\
  $listToken,                  # list file syntax: @C:\ProgramData\MediaSync\State\robocopy_list.txt
  "/E",                        # include subfolders (incl. empty)
  "/FFT",                      # 2-sec timestamp tolerance
  "/COPY:DAT",                 # Data, Attributes, Timestamps
  "/DCOPY:T",                  # Directory timestamps
  "/Z",                        # Restartable mode
  "/R:2","/W:5",               # conservative retries
  "/MT:$MaxThreads",           # gentle concurrency
  "/XO","/XN","/XC",           # no overwrites
  "/NP","/NFL","/NDL",         # quiet logging
  "/XJ","/SL",                 # avoid junction recursion; symlinks as files
  "/IF",                       # include files listed
  "/TEE",
  "/LOG+:$LogPath"
)

Write-Info ("Robocopy args: {0}" -f ($roboArgs -join ' '))
Write-Info "Starting robocopy..."
# Invoke via Start-Process to ensure reliable argument passing and capture exit code
$proc = Start-Process -FilePath "robocopy.exe" -ArgumentList $roboArgs -NoNewWindow -Wait -PassThru
$exitCode = $proc.ExitCode
Write-Info "Robocopy finished with exit code: $exitCode"

if ($exitCode -gt 7) {
  Write-Warn "Robocopy encountered failures (exit code: $exitCode). Manifest will not be updated."
  if (Test-Path $LogPath) {
    Write-Host "`n--- Last 200 lines of Robocopy log ---`n" -ForegroundColor Yellow
    Get-Content $LogPath -Tail 200
    Write-Host "`n--- End log tail ---`n" -ForegroundColor Yellow
  }
  Stop-Transcript | Out-Null
  exit $exitCode
}
# ---------------- Update manifest (no destination scan) ------------
foreach ($item in $deltaList) {
  $key = $item.Path.ToLowerInvariant()
  $manifest[$key] = $item
}

$manifest.GetEnumerator() |
  Sort-Object Name |
  ForEach-Object {
    [pscustomobject]@{
      Path             = $_.Value.Path
      Length           = $_.Value.Length
      LastWriteTimeUtc = $_.Value.LastWriteTimeUtc
    }
  } | Export-Csv -NoTypeInformation -Encoding UTF8 -Path $ManifestPath

Write-Info "Manifest updated: $ManifestPath"

Stop-Transcript | Out-Null
Write-Info "Done."
