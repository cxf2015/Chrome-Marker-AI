$ErrorActionPreference = "Stop"

$root = Split-Path -Parent $MyInvocation.MyCommand.Path
$zipPath = Join-Path $root "chorme_plug_in.zip"

if (Test-Path $zipPath) {
  Remove-Item $zipPath -Force
}

$items = Get-ChildItem -Path $root -Force | Where-Object {
  $_.Name -ne "chorme_plug_in.zip" -and $_.Name -ne ".git"
}

Compress-Archive -Path $items.FullName -DestinationPath $zipPath -CompressionLevel Optimal
Write-Host "Packed: $zipPath"
