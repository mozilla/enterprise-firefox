# capture env
Get-ChildItem Env: | Out-File "C:\startup_env.txt"

# allow powershell scripts to run
Set-ExecutionPolicy Unrestricted -Force -Scope Process

cd "C:\builds\actions-runner"

./config.cmd --url ##GH_REPO_URL## --unattended --ephemeral --replace --name ##GH_INSTANCE_NAME## --labels ##GH_LABELS## --token ##GH_RUNNER_TOKEN##

./run.cmd
