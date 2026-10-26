# Records the Planet Earth story voices on YOUR PC with Piper (free, offline, same engine as your Stories feature).
#   powershell -ExecutionPolicy Bypass -File .\make-planetearth-voice.ps1
#   (add -Force to re-record every line)
param([string]$Repo = (Join-Path $HOME 'Downloads\efootball-leagues-repo'), [switch]$Force)
$ErrorActionPreference = 'Stop'
function Say($m, $c = 'Cyan') { Write-Host $m -ForegroundColor $c }
function Fail($m) { Say "STOP: $m" 'Red'; Say 'Copy this whole window and send it to me and I will fix it.' 'Yellow'; exit 1 }
if (-not (Test-Path (Join-Path $Repo 'synthesize_planetearth.py'))) { Fail "Could not find synthesize_planetearth.py in $Repo. Install the Planet Earth story update first." }
Push-Location $Repo

Say '1/5  Checking Node...'
if (-not (Get-Command node -ErrorAction SilentlyContinue)) { Pop-Location; Fail 'Node.js was not found.' }

Say '2/5  Checking Python and Piper...'
$py = $null
foreach ($c in @('python', 'py')) { if (Get-Command $c -ErrorAction SilentlyContinue) { $py = $c; break } }
if (-not $py) { Pop-Location; Fail 'Python was not found. Install it from https://www.python.org/downloads/ (tick "Add python.exe to PATH") and run this again.' }
& $py -m piper --help *> $null
if ($LASTEXITCODE -ne 0) {
  Say '     Piper is not installed yet - installing it now (free, one time)...' 'Yellow'
  & $py -m pip install piper-tts
  if ($LASTEXITCODE -ne 0) { Pop-Location; Fail 'Could not install piper-tts.' }
}
if (-not (Get-Command ffmpeg -ErrorAction SilentlyContinue)) {
  Say '     Tip: ffmpeg is not installed, so the voices will be bigger WAV files. For ~6x smaller files run: winget install Gyan.FFmpeg  (then open a new PowerShell and run this again)' 'Yellow'
}

Say '3/5  Listing the story lines...'
node scripts/export-planetearth-voice-lines.mjs voice-work/planetearth-lines.json
if ($LASTEXITCODE -ne 0) { Pop-Location; Fail 'Could not list the story lines.' }
$ignore = Join-Path $Repo '.gitignore'
if ((Test-Path $ignore) -and -not (Select-String -Path $ignore -Pattern '^voice-work/?$' -Quiet)) { Add-Content -Path $ignore -Value "`nvoice-work/" }

Say '4/5  Recording the voices (the first run downloads 3 voice models, about 60 MB each)...'
$args2 = @('synthesize_planetearth.py', 'voice-work/planetearth-lines.json', '--out', 'public/planetearth-voice')
if ($Force) { $args2 += '--force' }
& $py @args2
$code = $LASTEXITCODE
if ($code -ne 0) { Pop-Location; Fail "Recording did not finish cleanly (code $code). Scroll up for the reason." }

Say '5/5  Done!' 'Green'
$files = Get-ChildItem 'public/planetearth-voice' -File
$mb = [math]::Round((($files | Measure-Object Length -Sum).Sum) / 1MB, 1)
Say "     $($files.Count) files, $mb MB in public/planetearth-voice" 'Green'
Pop-Location
Say ''
Say 'To put the voices live, run:' 'Green'
Say "    cd `"$Repo`"" 'White'
Say '    git add public/planetearth-voice .gitignore' 'White'
Say '    git commit -m "Planet Earth: story voices"' 'White'
Say '    git push' 'White'
