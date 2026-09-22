# Run this from inside your repo folder:
#   cd $HOME\Downloads\efootball-leagues-repo
#   git pull
#   .\apply-cash-ladder-wiring.ps1

$path = "src\App.jsx"
if (-not (Test-Path $path)) {
    Write-Error "Can't find $path -- run this script from inside the repo folder."
    exit 1
}

$content = Get-Content -Raw -LiteralPath $path

if ($content -match "CashLadder") {
    Write-Host "App.jsx already references CashLadder -- nothing to do. If the button still doesn't show, this wasn't the problem." -ForegroundColor Yellow
    exit 0
}

# 1) imports
$importAnchor = 'import { compressImage } from "./utils/imageCompress";'
$count1 = ([regex]::Matches($content, [regex]::Escape($importAnchor))).Count
if ($count1 -ne 1) { Write-Error "Import anchor not found exactly once (found $count1). Stopping -- send this back to Claude, the file changed again."; exit 1 }
$importReplacement = $importAnchor + "`r`nimport CashLadder from `"./CashLadder`";`r`nimport CashLadderAdmin from `"./CashLadderAdmin`";"
$content = $content -replace [regex]::Escape($importAnchor), $importReplacement

# 2) quick actions menu entry
$qaAnchor = '...(isAdmin ? [{ icon: Trophy, label: "League Ladder (Admin)", onClick: openLeagueLadderTestScreen }] : []),'
$count2 = ([regex]::Matches($content, [regex]::Escape($qaAnchor))).Count
if ($count2 -ne 1) { Write-Error "Quick-action anchor not found exactly once (found $count2). Stopping -- send this back to Claude, the file changed again."; exit 1 }
$qaReplacement = $qaAnchor + "`r`n    { icon: Wallet, label: `"Cash Ladder`", onClick: () => setView(`"cashLadder`") },`r`n    ...(isAdmin ? [{ icon: Wallet, label: `"Cash Ladder (Admin)`", onClick: () => setView(`"cashLadderAdmin`") }] : []),"
$content = $content -replace [regex]::Escape($qaAnchor), $qaReplacement

# 3) view render chain
$viewAnchor = ') : leagues === null ? <Loader c={c} /> : ('
$count3 = ([regex]::Matches($content, [regex]::Escape($viewAnchor))).Count
if ($count3 -ne 1) { Write-Error "View-render anchor not found exactly once (found $count3). Stopping -- send this back to Claude, the file changed again."; exit 1 }
$viewReplacement = ") : view === `"cashLadder`" ? (`r`n          <CashLadder session={session} profile={profile} c={c} onBack={goBack} />`r`n        ) : view === `"cashLadderAdmin`" && isAdmin ? (`r`n          <CashLadderAdmin c={c} />`r`n        " + $viewAnchor
$content = $content -replace [regex]::Escape($viewAnchor), $viewReplacement

Set-Content -LiteralPath $path -Value $content -NoNewline

$linesWithMatch = (Select-String -LiteralPath $path -Pattern "CashLadder").Count
Write-Host "Done. App.jsx now has $linesWithMatch lines mentioning CashLadder (should be 4)." -ForegroundColor Green
