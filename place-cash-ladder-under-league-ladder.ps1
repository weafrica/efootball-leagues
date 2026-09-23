# Run from inside your repo folder:
#   cd $HOME\Downloads\efootball-leagues-repo
#   git pull
#   powershell -ExecutionPolicy Bypass -File .\place-cash-ladder-under-league-ladder.ps1

$path = "src\App.jsx"
if (-not (Test-Path $path)) {
    Write-Error "Can't find $path -- run this from inside the repo folder."
    exit 1
}

$content = Get-Content -Raw -LiteralPath $path

if ($content.Contains("CashLadderHomeSection")) {
    Write-Host "Already placed -- nothing to do." -ForegroundColor Yellow
    exit 0
}

function Count-Literal($text, $needle) {
    return ([regex]::Matches($text, [regex]::Escape($needle))).Count
}

# 1) Home component signature: add onOpenCashLadder
$sigAnchor = 'onOpenTransferMarket, onOpenCompletedLeagues, memberAvatars, allAchievements, ladderChampions, onAchievementsSynced, myAvatarUrl, weekendOverride, onSetWeekendOverride, showToast, quickActions, onSuggestNotifications, c }) {'
if ((Count-Literal $content $sigAnchor) -ne 1) { Write-Error "Home signature anchor not found exactly once. Stopping -- send this back to Claude."; exit 1 }
$sigReplacement = $sigAnchor.Replace('onOpenTransferMarket, onOpenCompletedLeagues,', 'onOpenTransferMarket, onOpenCompletedLeagues, onOpenCashLadder,')
$content = $content.Replace($sigAnchor, $sigReplacement)

# 2) <Home /> call site: pass onOpenCashLadder
$callAnchor = 'ladder={ladderTop5} myLadderRank={myLadderRank} onOpenLadder={openLadderScreen} onOpenLeaderboard={() => setView("leaderboard")} onJoinLadder={joinLadder} onOpenLadderLeague={openLeagueLadder}'
if ((Count-Literal $content $callAnchor) -ne 1) { Write-Error "Home call-site anchor not found exactly once. Stopping -- send this back to Claude."; exit 1 }
$callReplacement = $callAnchor + ' onOpenCashLadder={() => setView("cashLadder")}'
$content = $content.Replace($callAnchor, $callReplacement)

# 3) Render <CashLadderHomeSection /> right after <LadderLeagueSection />
$renderAnchor = '<LadderLeagueSection session={session} isAdmin={isAdmin} onOpenLadderLeague={onOpenLadderLeague} c={c} />'
if ((Count-Literal $content $renderAnchor) -ne 1) { Write-Error "Render anchor not found exactly once. Stopping -- send this back to Claude."; exit 1 }
$renderReplacement = $renderAnchor + "`r`n        <CashLadderHomeSection session={session} c={c} onOpenCashLadder={onOpenCashLadder} />"
$content = $content.Replace($renderAnchor, $renderReplacement)

# 4) Define the CashLadderHomeSection component just before LadderLeagueSection
$defAnchor = 'function LadderLeagueSection({ session, isAdmin, onOpenLadderLeague, c }) {'
if ((Count-Literal $content $defAnchor) -ne 1) { Write-Error "Component-definition anchor not found exactly once. Stopping -- send this back to Claude."; exit 1 }

$newComponent = @'
function CashLadderHomeSection({ session, c, onOpenCashLadder }) {
  const [balance, setBalance] = useState(null);
  const [membership, setMembership] = useState(null);

  useEffect(() => {
    if (!session?.user?.id) return;
    supabase.from("cash_ladder_goats_wallet").select("balance").eq("user_id", session.user.id).maybeSingle()
      .then(({ data }) => setBalance(data?.balance ?? 0));
    supabase.from("cash_ladder_memberships").select("id").eq("user_id", session.user.id).eq("status", "active").maybeSingle()
      .then(({ data }) => setMembership(data || null));
  }, [session?.user?.id]);

  return (
    <section className="mt-8">
      <div className="flex items-center justify-between mb-3">
        <div className="flex items-center gap-2.5">
          <span className="w-8 h-8 rounded-lg flex items-center justify-center shrink-0" style={{ background: c.surfaceHover, border: `1px solid ${c.border}` }}>
            <Wallet size={15} style={{ color: c.accent }} />
          </span>
          <div className="font-extrabold uppercase tracking-tight text-lg leading-none">Cash Ladder</div>
        </div>
        <button onClick={onOpenCashLadder} className="font-body text-xs font-semibold px-3 py-1.5 rounded-full" style={{ background: c.accent, color: c.accentText }}>
          {membership ? "View" : "Join"}
        </button>
      </div>
      <div className="rounded-2xl p-4" style={{ background: c.bg, border: `1px solid ${c.border}` }}>
        <p className="font-body text-xs" style={{ color: c.textDim }}>
          {membership
            ? "You\u2019re in this season \u2014 tap View to see your matches."
            : balance
            ? `You have ${balance}G waiting \u2014 tap Join to enter this season.`
            : "Real-money League Ladder, same rules, paid out to the top finishers each season."}
        </p>
      </div>
    </section>
  );
}


'@

# Plain .Replace() here, NOT -replace: the new component text contains
# ${...} JSX template-literal syntax, which .NET's regex -replace would
# try to parse as a named-group backreference and either mangle or throw
# on. .Replace() is a literal string swap, no special characters at all.
$content = $content.Replace($defAnchor, ($newComponent + $defAnchor))

Set-Content -LiteralPath $path -Value $content -NoNewline

$finalLines = (Select-String -LiteralPath $path -Pattern "CashLadderHomeSection").Count
Write-Host "Done. App.jsx now has $finalLines lines mentioning CashLadderHomeSection (should be 2)." -ForegroundColor Green
