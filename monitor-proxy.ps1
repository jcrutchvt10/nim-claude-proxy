while ($true) {
    try {
        $h = Invoke-RestMethod -Uri 'http://localhost:3000/health' -Method Get -TimeoutSec 5
        Write-Host "$(Get-Date -Format o) Health: $($h.ok)"
    } catch {
        Write-Host "$(Get-Date -Format o) Health failed: $($_.Exception.Message)"
    }

    $conn = Get-NetTCPConnection -LocalPort 3000 -State Listen -ErrorAction SilentlyContinue | Select-Object -First 1
    if ($conn) {
        Write-Host "$(Get-Date -Format o) Proxy listening on port 3000, pid=$($conn.OwningProcess)"
    } else {
        Write-Host "$(Get-Date -Format o) Proxy not listening on port 3000"
    }

    Start-Sleep -Seconds 60
}
