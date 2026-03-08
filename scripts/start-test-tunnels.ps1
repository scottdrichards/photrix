param(
  [string]$DeployUser = "deploy",
  [string]$DeployHost = "192.168.1.97",
  [string]$IdentityFile = "$HOME/.ssh/id_ed25519"
)

$sshArgs = @(
  "-N",
  "-T",
  "-o", "ExitOnForwardFailure=yes",
  "-o", "ServerAliveInterval=30",
  "-o", "ServerAliveCountMax=3",
  "-i", $IdentityFile,
  "-R", "127.0.0.1:55173:127.0.0.1:5173",
  "-R", "127.0.0.1:53000:127.0.0.1:3000",
  "$DeployUser@$DeployHost"
)

Write-Host "Opening reverse tunnels to $DeployUser@$DeployHost ..."
Write-Host "  UI  : remote 127.0.0.1:55173 -> local 127.0.0.1:5173"
Write-Host "  API : remote 127.0.0.1:53000 -> local 127.0.0.1:3000"
Write-Host "Press Ctrl+C to close tunnels."

ssh @sshArgs
