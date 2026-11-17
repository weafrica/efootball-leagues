# Run from inside your repo folder:
#   cd $HOME\Downloads\efootball-leagues-repo
#   git pull
#   powershell -ExecutionPolicy Bypass -File .\rename-to-league-ladder-cash-rewards.ps1

$path = "src\App.jsx"
if (-not (Test-Path $path)) {
    Write-Error "Can't find $path -- run this from inside the repo folder."
    exit 1
}

$content = Get-Content -Raw -LiteralPath $path

if ($content.Contains('label: "League Ladder (Cash Rewards)"')) {
    Write-Host "Already renamed -- nothing to do." -ForegroundColor Yellow
    exit 0
}

function Count-Literal($text, $needle) {
    return ([regex]::Matches($text, [regex]::Escape($needle))).Count
}

$qa1Old = '{ icon: Wallet, label: "Cash Ladder", onClick: () => setView("cashLadder") },'
$qa1New = '{ icon: Wallet, label: "League Ladder (Cash Rewards)", onClick: () => setView("cashLadder") },'

$qa2Old = '{ icon: Wallet, label: "Cash Ladder (Admin)", onClick: () => setView("cashLadderAdmin") }'
$qa2New = '{ icon: Wallet, label: "League Ladder (Cash Rewards) Admin", onClick: () => setView("cashLadderAdmin") }'

$homeOld = '<div className="font-extrabold uppercase tracking-tight text-lg leading-none">Cash Ladder</div>'
$homeNew = '<div className="font-extrabold uppercase tracking-tight text-base leading-tight">League Ladder <span className="font-normal opacity-80">(Cash Rewards)</span></div>'

foreach ($pair in @(@($qa1Old, "quick-action"), @($qa2Old, "admin quick-action"), @($homeOld, "home title"))) {
    $n = Count-Literal $content $pair[0]
    if ($n -ne 1) { Write-Error "Anchor for $($pair[1]) not found exactly once (found $n). Stopping -- send this back to Claude, the file changed again."; exit 1 }
}

# Plain .Replace() -- literal text swap, no regex surprises.
$content = $content.Replace($qa1Old, $qa1New)
$content = $content.Replace($qa2Old, $qa2New)
$content = $content.Replace($homeOld, $homeNew)

Set-Content -LiteralPath $path -Value $content -NoNewline

$left = Count-Literal (Get-Content -Raw -LiteralPath $path) 'label: "Cash Ladder"'
Write-Host "Done. Old labels remaining: $left (should be 0)." -ForegroundColor Green
