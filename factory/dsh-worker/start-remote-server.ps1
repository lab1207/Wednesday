# start-remote-server.ps1
#
# Run this on the OTHER PC (the model server). It starts the llama.cpp server
# bound to 0.0.0.0 so this laptop can reach it over the LAN.
#
# Place llama-server.exe next to this script (same folder), and point -Model
# at your GGUF file. Windows will ask to allow the port through the firewall
# on first run — click Allow.
#
# Example:
#   .\start-remote-server.ps1 -Model C:\models\qwen2.5-coder-3b-instruct-q4_k_m.gguf
#   .\start-remote-server.ps1 -Model C:\models\qwen2.5-coder-3b-instruct-q4_k_m.gguf -GpuLayers 99
#
param(
  [int]$Port = 8080,
  [string]$Model = "C:\models\qwen2.5-coder-3b-instruct-q4_k_m.gguf",
  [string]$Alias = $null,
  [int]$Ctx = 32768,
  # 0 = CPU only (works with any GPU/vendor). For an NVIDIA card you can set
  # e.g. 99 to offload as much as fits into 4 GB VRAM.
  [int]$GpuLayers = 0
)

$server = Join-Path $PSScriptRoot "llama-server.exe"

if (-not (Test-Path $server)) {
  Write-Host "ERROR: llama-server.exe not found next to this script." -ForegroundColor Red
  Write-Host "Download it from github.com/ggml-org/llama.cpp/releases (win-cuda-cpu build)."
  exit 1
}
if (-not (Test-Path $Model)) {
  Write-Host "ERROR: model file not found: $Model" -ForegroundColor Red
  exit 1
}

if (-not $Alias) { $Alias = [System.IO.Path]::GetFileName($Model) }

Write-Host "Starting model server on 0.0.0.0:$Port (visible to the whole LAN)."
Write-Host "  model : $Model"
Write-Host "  alias : $Alias"
Write-Host "  gpu   : $GpuLayers layers (0 = CPU only)"
Write-Host ""
Write-Host "Find this PC's LAN IP on the laptop with:  ipconfig  (IPv4 address)"
Write-Host "Your laptop will use: http://<this-ip>:$Port/v1"
Write-Host ""
$ip = (Get-NetIPAddress -AddressFamily IPv4 -ErrorAction SilentlyContinue |
  Where-Object { $_.InterfaceAlias -notmatch 'Loopback' -and $_.IPAddress -notlike '169.254.*' } |
  Select-Object -First 1 -ExpandProperty IPAddress)
if ($ip) { Write-Host "Suggested URL for the laptop: http://$ip`:$Port/v1" }

$args = @(
  "--host", "0.0.0.0",
  "--port", "$Port",
  "--no-webui",
  "--jinja",
  "--alias", $Alias,
  "--ctx-size", "$Ctx",
  "--threads", "4",
  "--model", $Model
)
if ($GpuLayers -gt 0) {
  $args += "--n-gpu-layers", "$GpuLayers"
}

& $server @args