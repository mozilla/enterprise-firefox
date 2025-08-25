# From https://github.com/mozilla-platform-ops/monopacker/blob/main/scripts/generic-worker-windows/01-install-everything.ps1

# use TLS 1.2 (see bug 1443595)
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12

# capture env
Get-ChildItem Env: | Out-File "C:\install_env.txt"

"START" | Out-File "C:\install_status.txt"

# needed for making http requests
$client = New-Object system.net.WebClient
$shell = new-object -com shell.application

# allow powershell scripts to run
Set-ExecutionPolicy Unrestricted -Force -Scope Process

# download mozilla-build installer
$client.DownloadFile("https://ftp.mozilla.org/pub/mozilla.org/mozilla/libraries/win32/MozillaBuildSetup-Latest.exe", "C:\MozillaBuildSetup.exe")

# run mozilla-build installer in silent (/S) mode
Start-Process "C:\MozillaBuildSetup.exe" -ArgumentList "/S" -Wait -NoNewWindow -PassThru -RedirectStandardOutput "C:\MozillaBuild_install.log" -RedirectStandardError "C:\MozillaBuild_install.err"

# Create C:\builds and give full access to all users (for hg-shared, tooltool_cache, etc)
md "C:\builds"
$acl = Get-Acl -Path "C:\builds"
$ace = New-Object System.Security.AccessControl.FileSystemAccessRule("Everyone","Full","ContainerInherit,ObjectInherit","None","Allow")
$acl.AddAccessRule($ace)
Set-Acl "C:\builds" $acl

# install git
$client.DownloadFile("https://github.com/git-for-windows/git/releases/download/v2.51.0.windows.1/Git-2.51.0-64-bit.exe", "C:\Git-2.51.0-64-bit.exe")
Start-Process "C:\Git-2.51.0-64-bit.exe" -ArgumentList "/SILENT" -Wait -PassThru

# set permanent env vars
[Environment]::SetEnvironmentVariable("PATH", $Env:Path + ";C:\mozilla-build\python3;C:\mozilla-build\python3\Scripts;C:\Program Files\Git\cmd", "Machine")

winget install Microsoft.VisualStudio.2022.Community --silent --override "--wait --quiet --add ProductLang En-us --add Microsoft.VisualStudio.Workload.NativeDesktop --includeRecommended"

mkdir "C:\builds\.mozbuild"
cd "C:\builds\"

"MOZBUILD STATE" | Out-File "C:\install_status.txt"

[Environment]::SetEnvironmentVariable("MOZBUILD_STATE_PATH", "C:\builds\.mozbuild", "Machine")

git clone --branch main --depth 1 https://github.com/mozilla/firefox
cd firefox

"WILL BOOTSTRAP" | Out-File "C:\install_status.txt"

[Environment]::SetEnvironmentVariable("CARGO_HOME", "C:\builds\.cargo", "Machine")
[Environment]::SetEnvironmentVariable("RUSTUP_HOME", "C:\builds\.rustup", "Machine")
./mach --no-interactive bootstrap --application-choice="Firefox for Desktop"

# set permanent env vars
[Environment]::SetEnvironmentVariable("PATH", $Env:Path + ";C:\builds\.cargo\bin;C:\builds\.rustup\bin;C:\mozilla-build\python3;C:\mozilla-build\python3\Scripts;C:\Program Files\Git\cmd", "Machine")

"WILL RUSTUP DEFAULT" | Out-File "C:\install_status.txt"

rustup default stable

"ACTIONS RUNNER" | Out-File "C:\install_status.txt"

# Create a folder under the drive root
mkdir "C:\builds\actions-runner"
cd "C:\builds\actions-runner"

# Download the latest runner package
Invoke-WebRequest -Uri https://github.com/actions/runner/releases/download/v2.328.0/actions-runner-win-x64-2.328.0.zip -OutFile actions-runner-win-x64-2.328.0.zip

"ACTIONS RUNNER CHECK" | Out-File "C:\install_status.txt"

if((Get-FileHash -Path actions-runner-win-x64-2.328.0.zip -Algorithm SHA256).Hash.ToUpper() -ne 'a73ae192b8b2b782e1d90c08923030930b0b96ed394fe56413a073cc6f694877'.ToUpper()){ throw 'Computed checksum did not match' }

"ACTIONS RUNNER EXTRACT" | Out-File "C:\install_status.txt"

# Extract the installer
Add-Type -AssemblyName System.IO.Compression.FileSystem ; [System.IO.Compression.ZipFile]::ExtractToDirectory("$PWD/actions-runner-win-x64-2.328.0.zip", "$PWD")

"FINISHED" | Out-File "C:\install_status.txt"

Remove-Item -Force "C:\*.msi"

"CLEAN MSI" | Out-File "C:\install_status.txt"

Remove-Item -Force "C:\*.exe"

"CLEAN EXE" | Out-File "C:\install_status.txt"

Remove-Item -Recurse -Force "C:\builds\firefox"

"CLEAN SOURCE" | Out-File "C:\install_status.txt"

Remove-Item -Recurse -Force "C:\builds\actions-runner\actions-runner-win*.zip"

"CLEAN RUNNER" | Out-File "C:\install_status.txt"
