# Install or update the opencode-m365-copilot gateway from this repository's latest
# GitHub release, on Windows.
#
#   irm https://github.com/vincent1in/MS-Copilot-Code/releases/latest/download/install.ps1 | iex
#
# What it does, in order:
#   1. Downloads two files from the latest release on github.com (GitHub hands the
#      download to its file host, release-assets.githubusercontent.com):
#      opencode-m365-copilot.zip and opencode-m365-copilot.zip.sha256.
#   2. Checks the zip against that SHA-256, then every file in it against its own
#      SHA256SUMS list. It stops on any mismatch and installs nothing.
#   3. Puts the gateway in %LOCALAPPDATA%\opencode-m365-copilot, replacing an older
#      copy there. Your settings and sign-in are kept: they live in
#      %USERPROFILE%\.config\opencode-copilot, not in this folder.
#   4. Starts the gateway's page, unless M365_INSTALL_NO_START is set to 1.
#
# It downloads nothing else, runs no installer and needs no npm. It does not change
# OpenCode's config: the page's Connect OpenCode button does that when you press it.
#
# Options, as environment variables set before running it:
#   M365_INSTALL_NO_START=1   install only
#   M365_GATEWAY_DIR=<path>   install somewhere else
#   M365_INSTALL_ZIP=<path>   install a zip you already downloaded, checked against
#                             <path>.sha256 beside it; nothing is downloaded
# Run as a file, the same work as parameters:
#   powershell -ExecutionPolicy Bypass -File install.ps1 -Zip .\opencode-m365-copilot.zip -NoStart

param(
  [string]$Zip = $env:M365_INSTALL_ZIP,
  [string]$Dir = $env:M365_GATEWAY_DIR,
  [switch]$NoStart
)

function Install-M365Gateway([string]$Zip, [string]$Dir, [bool]$NoStart) {
  # Set here, not for the script: run with `iex`, the script shares your session.
  $ErrorActionPreference = 'Stop'
  $ProgressPreference = 'SilentlyContinue'
  $repo = 'vincent1in/MS-Copilot-Code'
  $name = 'opencode-m365-copilot'
  $base = "https://github.com/$repo/releases/latest/download"
  $dest = if ($Dir) { $Dir } else { Join-Path $env:LOCALAPPDATA $name }
  # A full path: .NET's zip code does not resolve relative paths the way PowerShell does.
  $dest = $ExecutionContext.SessionState.Path.GetUnresolvedProviderPathFromPSPath($dest)
  $start = -not $NoStart -and $env:M365_INSTALL_NO_START -ne '1'

  # GitHub accepts TLS 1.2 or later; older Windows PowerShell may not offer it by default.
  [Net.ServicePointManager]::SecurityProtocol = [Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12

  $node = Get-Command node -ErrorAction SilentlyContinue
  if ($node) {
    # No quotes in the expression: Windows PowerShell drops them on the way to node.
    $major = [int](& node -p 'parseInt(process.versions.node)')
    if ($major -lt 22) { Write-Host "Note: the gateway needs Node.js 22 or later, and this is $(& node --version)." }
  } else {
    Write-Host "Note: the gateway needs Node.js 22 or later, which isn't installed. Installing anyway."
    $start = $false
  }

  $tmp = Join-Path ([IO.Path]::GetTempPath()) ("$name-" + [Guid]::NewGuid().ToString('N'))
  New-Item -ItemType Directory -Path $tmp | Out-Null
  try {
    # PowerShell names are case-insensitive: these must not reuse $Zip.
    $zipFile = Join-Path $tmp "$name.zip"
    $sumFile = Join-Path $tmp "$name.zip.sha256"
    if ($Zip) {
      if (-not (Test-Path -LiteralPath $Zip) -or -not (Test-Path -LiteralPath "$Zip.sha256")) {
        throw "Installing from a zip needs the zip, and its .sha256 file beside it."
      }
      Write-Host "Installing $Zip, checked against $Zip.sha256. Nothing is downloaded."
      Copy-Item -LiteralPath $Zip -Destination $zipFile
      Copy-Item -LiteralPath "$Zip.sha256" -Destination $sumFile
    } else {
      Write-Host "Downloading the latest release from github.com/${repo}:"
      Write-Host "  $name.zip"
      Invoke-WebRequest -Uri "$base/$name.zip" -OutFile $zipFile -UseBasicParsing
      Write-Host "  $name.zip.sha256"
      Invoke-WebRequest -Uri "$base/$name.zip.sha256" -OutFile $sumFile -UseBasicParsing
    }

    $expected = ((Get-Content -Raw -LiteralPath $sumFile).Trim() -split '\s+')[0].ToLowerInvariant()
    $actual = (Get-FileHash -Algorithm SHA256 -LiteralPath $zipFile).Hash.ToLowerInvariant()
    if (-not $expected -or $expected -ne $actual) {
      throw "The zip's SHA-256 is $actual, not the published $expected. Nothing was installed."
    }
    Write-Host "Checked the zip: SHA-256 $actual"

    # Unpacked beside the install folder, so the moves below stay on one drive.
    $parent = Split-Path -Parent $dest
    if ($parent -and -not (Test-Path -LiteralPath $parent)) { New-Item -ItemType Directory -Path $parent | Out-Null }
    $unzipped = "$dest.new"
    if (Test-Path -LiteralPath $unzipped) { Remove-Item -LiteralPath $unzipped -Recurse -Force }
    Add-Type -AssemblyName System.IO.Compression.FileSystem
    [IO.Compression.ZipFile]::ExtractToDirectory($zipFile, $unzipped)
    $folder = Get-ChildItem -LiteralPath $unzipped -Directory | Where-Object { $_.Name -like "$name-*" } | Select-Object -Last 1
    if (-not $folder -or -not (Test-Path -LiteralPath (Join-Path $folder.FullName 'dist\cli.mjs')) -or -not (Test-Path -LiteralPath (Join-Path $folder.FullName 'SHA256SUMS'))) {
      throw "The zip doesn't hold the gateway's folder. Nothing was installed."
    }

    $bad = @()
    foreach ($line in Get-Content -LiteralPath (Join-Path $folder.FullName 'SHA256SUMS')) {
      if ($line -notmatch '^([0-9a-fA-F]{64}) [ *](.+)$') { continue }
      $file = Join-Path $folder.FullName ($Matches[2] -replace '/', '\')
      if (-not (Test-Path -LiteralPath $file) -or (Get-FileHash -Algorithm SHA256 -LiteralPath $file).Hash -ne $Matches[1].ToUpperInvariant()) {
        $bad += $Matches[2]
      }
    }
    if ($bad.Count -gt 0) {
      throw "These files in the zip don't match SHA256SUMS: $($bad -join ', '). Nothing was installed."
    }
    $version = ((Get-Content -LiteralPath (Join-Path $folder.FullName 'BUILD-INFO.txt') -TotalCount 1) -split ' ')[1]
    Write-Host "Checked every file in it against SHA256SUMS: version $version"

    if (Test-Path -LiteralPath $dest) {
      if (-not (Test-Path -LiteralPath (Join-Path $dest 'BUILD-INFO.txt')) -and -not (Test-Path -LiteralPath (Join-Path $dest 'dist\cli.mjs'))) {
        throw "$dest exists and isn't a copy of the gateway. Set M365_GATEWAY_DIR to another folder."
      }
      $previous = "$dest.previous"
      if (Test-Path -LiteralPath $previous) { Remove-Item -LiteralPath $previous -Recurse -Force }
      try {
        Move-Item -LiteralPath $dest -Destination $previous
      } catch {
        throw "Couldn't replace $dest, most likely because the gateway or OpenCode is running from it. Close the gateway's window and OpenCode, then run this again."
      }
      Move-Item -LiteralPath $folder.FullName -Destination $dest
      Remove-Item -LiteralPath $previous -Recurse -Force
      Write-Host "Updated the gateway in $dest to $version."
      Write-Host "If OpenCode is running, restart it to load the new version."
    } else {
      Move-Item -LiteralPath $folder.FullName -Destination $dest
      Write-Host "Installed the gateway in $dest."
    }
  } finally {
    Remove-Item -LiteralPath $tmp -Recurse -Force -ErrorAction SilentlyContinue
    if ($unzipped) { Remove-Item -LiteralPath $unzipped -Recurse -Force -ErrorAction SilentlyContinue }
  }

  $cli = Join-Path $dest 'dist\cli.mjs'
  if ($start) {
    Write-Host ""
    Write-Host "Starting the gateway's page. Stop it with Ctrl+C; start it again with:"
    Write-Host "  node `"$cli`" start"
    & node $cli start
  } else {
    Write-Host "Start the gateway's page with: node `"$cli`" start"
  }
}

Install-M365Gateway -Zip $Zip -Dir $Dir -NoStart $NoStart.IsPresent
