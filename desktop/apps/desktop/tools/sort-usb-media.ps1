# sort-usb-media.ps1
#
# Scans the whole USB drive (E:\) for video files, sorts them into your
# Beebo Entertainment library (D:\MovieAPP\Movies and D:\MovieAPP\TVShows), and COPIES
# them there (your USB drive is left untouched).
#
# Safe to re-run: it skips any file that already exists at the destination,
# so if you stop it partway through (or run it again later after adding more
# files to the USB), it just picks up where it left off instead of re-copying
# everything.
#
# HOW TO USE:
#   1. First run it in DRY RUN mode (the default below) to see what it WOULD
#      do and how much space it needs, without copying anything:
#         powershell -ExecutionPolicy Bypass -File "D:\MovieAPP\sort-usb-media.ps1"
#   2. If the summary looks right and there's enough free space, open this
#      file, change $DryRun below to $false, and run it again to actually copy.

$DryRun = $true

# You've now got more free space on D:\, so this run also includes movies.
# Still starting in dry-run mode below — run it once to see the summary
# (how many movies, how much space needed, how much is free) before flipping
# $DryRun to $false to actually copy.
$CopyMovies = $true
$CopyTv     = $true

$Source              = "E:\"
$DestMovies          = "D:\MovieAPP\Movies"
$DestTv              = "D:\MovieAPP\TVShows"
$LogFile             = "D:\MovieAPP\sort-usb-media-log.txt"
# Written by the app's "📁 delete files from this folder" review dialog —
# whenever you delete a personal-video folder from inside Beebo Entertainment and check
# "don't import from this folder again," its path gets added here, so future
# USB imports skip it automatically without you having to edit this script.
$ExcludedFoldersFile = "D:\MovieAPP\excluded-source-folders.json"

$VideoExtensions = @('.mp4', '.mkv', '.avi', '.mov', '.wmv', '.flv', '.m4v', '.mpg', '.mpeg', '.divx', '.webm', '.ts')
# Incomplete/partial downloads — never copy these, they're broken files.
$SkipExtensions  = @('.part', '.crdownload', '.download', '.tmp')
# Folders to leave alone entirely (personal photos/files, not media library content).
$ExcludeFolders  = @('E:\Nicks\Camera', 'E:\Nicks\Work  Photos', 'E:\Nicks\Justine', 'E:\Nicks\new auto it', 'E:\Nicks\Star Wars Stuff', 'E:\Nicks\Trina', 'E:\Camera viveks wedding', 'E:\Wedding Photos', 'E:\Justine', 'E:\Wedding Reception Slideshow', 'E:\desktopDECEMBER2018', 'E:\Antigua 2018')

if (Test-Path -LiteralPath $ExcludedFoldersFile) {
    try {
        $appExcluded = Get-Content -LiteralPath $ExcludedFoldersFile -Raw | ConvertFrom-Json
        if ($appExcluded) {
            $ExcludeFolders = @($ExcludeFolders) + @($appExcluded)
            Write-Host ("Loaded {0} folder(s) excluded from inside the app." -f @($appExcluded).Count) -ForegroundColor Cyan
        }
    } catch {
        Write-Host ("Couldn't read {0} — continuing without app-excluded folders." -f $ExcludedFoldersFile) -ForegroundColor Yellow
    }
}

# Recognizes "S01E02", "1x05", "Season 1 Episode 2" anywhere in a filename —
# same idea as the show/episode detection already used inside the Beebo Entertainment app.
$EpisodePattern = '(?i)[.\s_-]S(\d{1,2})[.\s_-]?E(\d{1,3})[.\s_-]|(?i)[.\s_-](\d{1,2})x(\d{1,3})[.\s_-]|(?i)Season[.\s_-]?\d{1,2}[.\s_-]+Episode[.\s_-]?\d{1,3}'

function Clean-Title($raw) {
    $t = $raw -replace '[._]', ' '
    $t = $t -replace '\s+', ' '
    return $t.Trim()
}

# Given a loose episode filename (not already inside an organized show
# folder), guesses the show name by cutting the filename off right before
# the SxxExx / NxNN marker.
function Guess-ShowName($fileName) {
    $noExt = [System.IO.Path]::GetFileNameWithoutExtension($fileName)
    if ($noExt -match '(?i)^(.*?)[.\s_-]S\d{1,2}[.\s_-]?E\d{1,3}') { return Clean-Title $matches[1] }
    if ($noExt -match '(?i)^(.*?)[.\s_-](\d{1,2})x(\d{1,3})') { return Clean-Title $matches[1] }
    return Clean-Title $noExt
}

Write-Host "Scanning $Source for video files... this can take a while on a big drive." -ForegroundColor Cyan

$allFiles = Get-ChildItem -LiteralPath $Source -Recurse -Force -ErrorAction SilentlyContinue | Where-Object { -not $_.PSIsContainer }

$candidates = @()
foreach ($f in $allFiles) {
    $ext = $f.Extension.ToLower()
    if ($SkipExtensions -contains $ext) { continue }
    if ($VideoExtensions -notcontains $ext) { continue }
    $excluded = $false
    foreach ($ex in $ExcludeFolders) {
        if ($f.FullName -like "$ex\*" -or $f.FullName -eq $ex) { $excluded = $true; break }
    }
    if ($excluded) { continue }
    $candidates += $f
}

Write-Host ("Found {0} video files on the USB drive." -f $candidates.Count) -ForegroundColor Cyan

# Classify each file: TV (with a target show folder) or Movie.
$plan = @()
foreach ($f in $candidates) {
    $relParts = $f.FullName.Substring($Source.Length).Split('\')
    $isEpisode = $f.Name -match $EpisodePattern

    if ($isEpisode) {
        # Guess the show name from the FILENAME first — download filenames
        # almost always have the real show name right before the SxxExx
        # marker (e.g. "The.Blacklist.S04E01...mkv" -> "The Blacklist"), and
        # this is reliable no matter what folder the file happens to sit in.
        # Only fall back to the parent folder's name if the filename doesn't
        # yield anything usable. (Trusting the parent folder name first was
        # the old approach, but it's wrong whenever a folder is a generic
        # dumping ground holding loose episodes from many different shows —
        # e.g. "E:\Nicks\TvShows and Movies\" — since every file in it would
        # incorrectly get named after the container folder itself instead of
        # its actual show.)
        $showName = Guess-ShowName $f.Name
        if (-not $showName) {
            $parentName = $f.Directory.Name
            if ($relParts.Length -gt 2) {
                $showName = Clean-Title $parentName
            }
        }
        if (-not $showName) { $showName = "Unsorted" }
        $dest = Join-Path (Join-Path $DestTv $showName) $f.Name
        $plan += [PSCustomObject]@{ Source = $f.FullName; Dest = $dest; Kind = 'TV'; Size = $f.Length }
    } else {
        $dest = Join-Path $DestMovies $f.Name
        $plan += [PSCustomObject]@{ Source = $f.FullName; Dest = $dest; Kind = 'Movie'; Size = $f.Length }
    }
}

$categoryEnabled = $plan | Where-Object { ($_.Kind -eq 'Movie' -and $CopyMovies) -or ($_.Kind -eq 'TV' -and $CopyTv) }
$toCopy = $categoryEnabled | Where-Object { -not (Test-Path -LiteralPath $_.Dest) }
$alreadyThere = $categoryEnabled.Count - $toCopy.Count
$skippedByCategory = $plan.Count - $categoryEnabled.Count
$totalBytesToCopy = ($toCopy | Measure-Object -Property Size -Sum).Sum
if (-not $totalBytesToCopy) { $totalBytesToCopy = 0 }
$totalGbToCopy = [math]::Round($totalBytesToCopy / 1GB, 1)

$tvCount = ($toCopy | Where-Object { $_.Kind -eq 'TV' }).Count
$movieCount = ($toCopy | Where-Object { $_.Kind -eq 'Movie' }).Count

$destDrive = Get-PSDrive -Name (Split-Path -Qualifier $DestMovies).TrimEnd(':')
$freeGb = [math]::Round($destDrive.Free / 1GB, 1)

Write-Host ""
Write-Host "=== Summary ===" -ForegroundColor Yellow
Write-Host ("Movies to copy:     {0}" -f $movieCount)
Write-Host ("TV episodes to copy: {0}" -f $tvCount)
Write-Host ("Already in your library (skipped): {0}" -f $alreadyThere)
Write-Host ("Skipped this run (CopyMovies/CopyTv turned off): {0}" -f $skippedByCategory)
Write-Host ("Total size to copy: {0} GB" -f $totalGbToCopy)
Write-Host ("Free space on D:\:  {0} GB" -f $freeGb)
Write-Host ""

# Doesn't need to fit everything in one go anymore — if the full list is
# bigger than what's free, it just copies as much as fits this run (leaving
# a 20 GB safety margin) and leaves the rest for next time. Since the script
# always skips files already at the destination, you can just re-run it
# after freeing up more space (or adding storage) to pick up where it left
# off — no need to track what's left by hand.
$budgetBytes = [math]::Max(0, ($freeGb - 20)) * 1GB
$batch = New-Object System.Collections.Generic.List[object]
$batchBytes = 0
foreach ($item in $toCopy) {
    if (($batchBytes + $item.Size) -gt $budgetBytes) { continue }
    $batch.Add($item)
    $batchBytes += $item.Size
}
$batchGb = [math]::Round($batchBytes / 1GB, 1)
$leftoverCount = $toCopy.Count - $batch.Count
$leftoverGb = [math]::Round(($totalBytesToCopy - $batchBytes) / 1GB, 1)

if ($batch.Count -eq 0) {
    Write-Host "NOT ENOUGH FREE SPACE to copy even one more file (keeping a 20 GB safety margin) — stopping." -ForegroundColor Red
    Write-Host "Free up space on D:\ or add storage, then re-run." -ForegroundColor Red
    exit 1
}

if ($leftoverCount -gt 0) {
    Write-Host ("This run will copy {0} of {1} remaining files ({2} GB) — that's what fits with a 20 GB safety margin." -f $batch.Count, $toCopy.Count, $batchGb) -ForegroundColor Yellow
    Write-Host ("{0} files ({1} GB) will be left for a future run once you've freed up more space." -f $leftoverCount, $leftoverGb) -ForegroundColor Yellow
    Write-Host ""
}

if ($DryRun) {
    Write-Host "DRY RUN — nothing was copied. Set `$DryRun = `$false at the top of this script and re-run to actually copy." -ForegroundColor Yellow
    exit 0
}

Write-Host "Copying files now — this can take a long time for a large library. Progress is logged to:" -ForegroundColor Cyan
Write-Host $LogFile
# Appends across runs rather than wiping the log each time — the app reads
# this log to know which USB source folder each library file came from
# (for the "delete files from this folder" cleanup feature), so old runs'
# entries need to stick around, not just this run's.
if (-not (Test-Path -LiteralPath $LogFile)) {
    "" | Out-File -FilePath $LogFile -Encoding utf8
}

$done = 0
$failed = 0
foreach ($item in $batch) {
    $destDir = Split-Path $item.Dest -Parent
    if (-not (Test-Path -LiteralPath $destDir)) {
        New-Item -ItemType Directory -Path $destDir -Force | Out-Null
    }
    try {
        Copy-Item -LiteralPath $item.Source -Destination $item.Dest -Force -ErrorAction Stop
        $done++
        "$($item.Kind): $($item.Source) -> $($item.Dest)" | Out-File -FilePath $LogFile -Append -Encoding utf8
    } catch {
        $failed++
        "FAILED: $($item.Source) -- $($_.Exception.Message)" | Out-File -FilePath $LogFile -Append -Encoding utf8
    }
    if (($done + $failed) % 25 -eq 0) {
        Write-Host ("...{0}/{1} done" -f ($done + $failed), $batch.Count)
    }
}

Write-Host ""
Write-Host "=== Done ===" -ForegroundColor Green
Write-Host ("Copied: {0}" -f $done)
Write-Host ("Failed: {0} (see log for details)" -f $failed)
Write-Host ("Log file: {0}" -f $LogFile)
