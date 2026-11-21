# Creates a "Vizor Local" shortcut on the desktop (once). Safe to run again.
$cmd = Join-Path (Split-Path $PSScriptRoot -Parent) "Start Vizor Local.cmd"
$lnk = Join-Path ([Environment]::GetFolderPath("Desktop")) "Vizor Local.lnk"
if (Test-Path $lnk) { exit 0 }
$s = (New-Object -ComObject WScript.Shell).CreateShortcut($lnk)
$s.TargetPath = $cmd
$s.WorkingDirectory = Split-Path $cmd
$s.Description = "Start Vizor Local"
$s.Save()
Write-Host "Added a Vizor Local shortcut to your desktop."
