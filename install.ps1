#requires -Version 5.1

[CmdletBinding()]
param(
    [ValidateRange(1, 65535)]
    [int]$Port = 3003,
    [string]$PublicBaseUrl = '',
    [string]$ModelBaseUrl = '',
    [string]$ModelId = '',
    [string]$KnowledgeEmbeddingModel = '',
    [switch]$SkipDockerCheck,
    [switch]$SkipStart,
    [switch]$DisableKnowledgeEmbedding
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$RepoRoot = $PSScriptRoot
$EnvPath = Join-Path $RepoRoot '.env.local'
$TemplatePath = Join-Path $RepoRoot '.env.example'

function Write-Step {
    param([string]$Message)

    Write-Host ""
    Write-Host "[OpenMAIC] $Message" -ForegroundColor Cyan
}

function New-RandomHex {
    param([int]$ByteCount = 32)

    $bytes = New-Object byte[] $ByteCount
    $rng = [System.Security.Cryptography.RandomNumberGenerator]::Create()
    try {
        $rng.GetBytes($bytes)
    }
    finally {
        $rng.Dispose()
    }

    return (($bytes | ForEach-Object { $_.ToString('x2') }) -join '')
}

function Get-EnvValue {
    param(
        [string]$Content,
        [string]$Name
    )

    $pattern = '(?m)^[ \t]*' + [regex]::Escape($Name) + '[ \t]*=(.*?)\r?$'
    $match = [regex]::Match($Content, $pattern)
    if (-not $match.Success) {
        return ''
    }

    $value = $match.Groups[1].Value.Trim()
    if ($value.Length -ge 2) {
        $quotedWithDouble = $value.StartsWith('"') -and $value.EndsWith('"')
        $quotedWithSingle = $value.StartsWith("'") -and $value.EndsWith("'")
        if ($quotedWithDouble -or $quotedWithSingle) {
            $value = $value.Substring(1, $value.Length - 2)
        }
    }

    return $value
}

function Set-EnvValue {
    param(
        [string]$Content,
        [string]$Name,
        [string]$Value
    )

    $lines = New-Object System.Collections.Generic.List[string]
    foreach ($line in ($Content -split '\r?\n')) {
        [void]$lines.Add($line)
    }

    while ($lines.Count -gt 1 -and [string]::IsNullOrWhiteSpace($lines[$lines.Count - 1])) {
        $lines.RemoveAt($lines.Count - 1)
    }

    $keyPattern = '^[ \t]*' + [regex]::Escape($Name) + '[ \t]*='
    $found = $false
    for ($index = 0; $index -lt $lines.Count; $index += 1) {
        if ($lines[$index] -match $keyPattern) {
            $lines[$index] = "$Name=$Value"
            $found = $true
        }
    }

    if (-not $found) {
        [void]$lines.Add("$Name=$Value")
    }

    return (($lines -join "`r`n") + "`r`n")
}

function Merge-ModelRoutes {
    param(
        [string]$Json,
        [string]$ModelId
    )

    $routes = [ordered]@{}
    if (-not [string]::IsNullOrWhiteSpace($Json)) {
        try {
            $parsedRoutes = ConvertFrom-Json -InputObject $Json -ErrorAction Stop
        }
        catch {
            throw 'MODEL_ROUTES must be a valid JSON object. Fix the existing value before running install.ps1.'
        }

        if ($null -eq $parsedRoutes -or $parsedRoutes -isnot [System.Management.Automation.PSCustomObject]) {
            throw 'MODEL_ROUTES must be a JSON object whose keys are generation stage names.'
        }

        foreach ($property in $parsedRoutes.PSObject.Properties) {
            $routes[$property.Name] = $property.Value
        }
    }

    $routes['maic-agent-driver'] = [ordered]@{
        model = "openai:$ModelId"
        api = 'openai-completions'
    }

    return ($routes | ConvertTo-Json -Compress -Depth 20)
}

function Get-LanAddress {
    $candidates = @()
    $configurations = Get-NetIPConfiguration -ErrorAction SilentlyContinue |
        Where-Object {
            $null -ne $_.IPv4DefaultGateway -and
            $null -ne $_.NetAdapter -and
            $_.NetAdapter.Status -eq 'Up'
        }

    foreach ($configuration in $configurations) {
        foreach ($address in @($configuration.IPv4Address)) {
            if ($null -eq $address) {
                continue
            }

            $ip = [string]$address.IPAddress
            if ($ip -eq '127.0.0.1' -or $ip.StartsWith('169.254.')) {
                continue
            }

            $rank = 9
            if ($ip.StartsWith('192.168.')) {
                $rank = 0
            }
            elseif ($ip.StartsWith('10.')) {
                $rank = 1
            }
            elseif ($ip -match '^172\.(1[6-9]|2[0-9]|3[0-1])\.') {
                $rank = 2
            }

            $candidates += [pscustomobject]@{
                Address = $ip
                Rank = $rank
                Alias = [string]$configuration.InterfaceAlias
            }
        }
    }

    $selected = $candidates |
        Sort-Object Rank, Alias |
        Select-Object -First 1
    if ($null -ne $selected) {
        return $selected.Address
    }

    $fallback = Get-NetIPAddress -AddressFamily IPv4 -ErrorAction SilentlyContinue |
        Where-Object {
            $_.IPAddress -ne '127.0.0.1' -and
            -not $_.IPAddress.StartsWith('169.254.') -and
            $_.InterfaceAlias -notmatch 'Loopback|vEthernet|WSL|Docker'
        } |
        Select-Object -First 1
    if ($null -ne $fallback) {
        return [string]$fallback.IPAddress
    }

    return 'localhost'
}

function Resolve-PublicBaseUrl {
    param(
        [string]$Value,
        [int]$HostPort
    )

    $candidate = $Value.Trim()
    if ([string]::IsNullOrWhiteSpace($candidate)) {
        $candidate = "http://$(Get-LanAddress):$HostPort"
    }
    elseif ($candidate -notmatch '^[a-zA-Z][a-zA-Z0-9+.-]*://') {
        $candidate = "http://$candidate"
    }

    $uri = $null
    if (-not [Uri]::TryCreate($candidate, [UriKind]::Absolute, [ref]$uri)) {
        throw "Invalid public base URL: $Value"
    }
    if ($uri.Scheme -notin @('http', 'https')) {
        throw "Public base URL must use http or https: $Value"
    }

    $hasExplicitPort = $candidate -match '^[a-zA-Z][a-zA-Z0-9+.-]*://(\[[^\]]+\]|[^/:]+):\d+'
    if (-not $hasExplicitPort -and $uri.Scheme -eq 'http') {
        $builder = New-Object System.UriBuilder($uri)
        $builder.Port = $HostPort
        $candidate = $builder.Uri.AbsoluteUri
    }

    if ($uri.Host -in @('localhost', '127.0.0.1', '::1')) {
        Write-Warning 'The integration public URL points to localhost. Remote browsers will not be able to open returned course links.'
    }

    return $candidate.TrimEnd('/')
}

function Normalize-ModelBaseUrl {
    param([string]$Value)

    $candidate = $Value.Trim()
    if ($candidate -notmatch '^[a-zA-Z][a-zA-Z0-9+.-]*://') {
        $candidate = "https://$candidate"
    }

    $uri = $null
    if (-not [Uri]::TryCreate($candidate, [UriKind]::Absolute, [ref]$uri)) {
        throw "Invalid model base URL: $Value"
    }
    if ($uri.Scheme -notin @('http', 'https')) {
        throw "Model base URL must use http or https: $Value"
    }

    return $candidate.TrimEnd('/')
}

function Read-HiddenValue {
    param([string]$Prompt)

    $secureValue = Read-Host -Prompt $Prompt -AsSecureString
    $pointer = [IntPtr]::Zero
    try {
        $pointer = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($secureValue)
        return [Runtime.InteropServices.Marshal]::PtrToStringBSTR($pointer)
    }
    finally {
        if ($pointer -ne [IntPtr]::Zero) {
            [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($pointer)
        }
    }
}

function Wait-ForHealth {
    param(
        [int]$HostPort,
        [int]$TimeoutSeconds = 600
    )

    $deadline = (Get-Date).AddSeconds($TimeoutSeconds)
    $healthUrl = "http://localhost:$HostPort/api/health"
    while ((Get-Date) -lt $deadline) {
        try {
            $response = Invoke-WebRequest -Uri $healthUrl -UseBasicParsing -TimeoutSec 5
            if ($response.StatusCode -eq 200) {
                return $true
            }
        }
        catch {
            # The container is still starting.
        }

        Start-Sleep -Seconds 3
    }

    return $false
}

Write-Host "OpenMAIC installer" -ForegroundColor Green
Write-Host "Repository: $RepoRoot"

if (-not (Test-Path $RepoRoot -PathType Container)) {
    throw "Repository directory does not exist: $RepoRoot"
}
if (-not (Test-Path (Join-Path $RepoRoot 'docker-compose.yml') -PathType Leaf)) {
    throw 'docker-compose.yml was not found. Run this script from the OpenMAIC repository.'
}

if (-not $SkipDockerCheck) {
    Write-Step 'Checking Docker Desktop and Docker Compose v2'
    if ($null -eq (Get-Command docker -ErrorAction SilentlyContinue)) {
        throw 'Docker was not found. Install Docker Desktop and start it before running this script.'
    }

    & docker compose version *> $null
    if ($LASTEXITCODE -ne 0) {
        throw 'Docker Compose v2 is not available. Update Docker Desktop and try again.'
    }

    & docker info *> $null
    if ($LASTEXITCODE -ne 0) {
        throw 'Docker Desktop is installed but not running. Start Docker Desktop and try again.'
    }
}

$envExists = Test-Path $EnvPath -PathType Leaf
if ($envExists) {
    $envContent = [System.IO.File]::ReadAllText($EnvPath, [System.Text.Encoding]::UTF8)
    $timestamp = Get-Date -Format 'yyyyMMdd-HHmmss'
    $backupPath = "$EnvPath.$timestamp.bak"
    Copy-Item -LiteralPath $EnvPath -Destination $backupPath
    Write-Host "Existing configuration backed up to: $backupPath"
}
else {
    if (-not (Test-Path $TemplatePath -PathType Leaf)) {
        throw '.env.example was not found.'
    }

    $envContent = [System.IO.File]::ReadAllText($TemplatePath, [System.Text.Encoding]::UTF8)
}

$defaultModelBaseUrl = Get-EnvValue -Content $envContent -Name 'OPENAI_BASE_URL'
if ([string]::IsNullOrWhiteSpace($defaultModelBaseUrl)) {
    $defaultModelBaseUrl = 'https://api.deepseek.com/v1'
}

$defaultModelId = Get-EnvValue -Content $envContent -Name 'OPENAI_MODELS'
if ([string]::IsNullOrWhiteSpace($defaultModelId)) {
    $defaultModelId = 'deepseek-v4-pro'
}
$defaultModelId = ($defaultModelId -split ',')[0].Trim()

Write-Step 'Configure the language model'
if ([string]::IsNullOrWhiteSpace($ModelBaseUrl)) {
    $enteredBaseUrl = Read-Host "Model base URL [$defaultModelBaseUrl]"
    if ([string]::IsNullOrWhiteSpace($enteredBaseUrl)) {
        $ModelBaseUrl = $defaultModelBaseUrl
    }
    else {
        $ModelBaseUrl = $enteredBaseUrl
    }
}
$ModelBaseUrl = Normalize-ModelBaseUrl -Value $ModelBaseUrl

if ([string]::IsNullOrWhiteSpace($ModelId)) {
    $enteredModelId = Read-Host "Model ID [$defaultModelId]"
    if ([string]::IsNullOrWhiteSpace($enteredModelId)) {
        $ModelId = $defaultModelId
    }
    else {
        $ModelId = $enteredModelId
    }
}
$ModelId = $ModelId.Trim()
if ($ModelId.StartsWith('openai:')) {
    $ModelId = $ModelId.Substring('openai:'.Length)
}
if ([string]::IsNullOrWhiteSpace($ModelId)) {
    throw 'Model ID cannot be empty.'
}

$existingApiKey = Get-EnvValue -Content $envContent -Name 'OPENAI_API_KEY'
$keyPrompt = if ($envExists -and -not [string]::IsNullOrWhiteSpace($existingApiKey)) {
    'Model API key (leave blank to keep the current key)'
}
else {
    'Model API key'
}
$apiKey = [Environment]::GetEnvironmentVariable('OPENMAIC_INSTALL_API_KEY', 'Process')
if ([string]::IsNullOrWhiteSpace($apiKey)) {
    $apiKey = Read-HiddenValue -Prompt $keyPrompt
}
if ([string]::IsNullOrWhiteSpace($apiKey)) {
    $apiKey = $existingApiKey
}
if ([string]::IsNullOrWhiteSpace($apiKey)) {
    throw 'A model API key is required.'
}

$existingKnowledgeEmbeddingModel = Get-EnvValue -Content $envContent -Name 'KNOWLEDGE_BASE_EMBEDDING_MODEL'
if ($DisableKnowledgeEmbedding) {
    $KnowledgeEmbeddingModel = ''
}
elseif ([string]::IsNullOrWhiteSpace($KnowledgeEmbeddingModel)) {
    $embeddingPrompt = if ([string]::IsNullOrWhiteSpace($existingKnowledgeEmbeddingModel)) {
        'Knowledge-base embedding model (provider:model, leave blank to disable vector indexing)'
    }
    else {
        "Knowledge-base embedding model [$existingKnowledgeEmbeddingModel] (leave blank to keep; enter '-' to disable)"
    }

    $enteredKnowledgeEmbeddingModel = Read-Host $embeddingPrompt
    if ([string]::IsNullOrWhiteSpace($enteredKnowledgeEmbeddingModel)) {
        $KnowledgeEmbeddingModel = $existingKnowledgeEmbeddingModel
    }
    else {
        $KnowledgeEmbeddingModel = $enteredKnowledgeEmbeddingModel.Trim()
    }
}
if ($KnowledgeEmbeddingModel -eq '-') {
    $KnowledgeEmbeddingModel = ''
}
if (
    -not [string]::IsNullOrWhiteSpace($KnowledgeEmbeddingModel) -and
    $KnowledgeEmbeddingModel -notmatch '^[A-Za-z0-9][A-Za-z0-9._-]*:\S+$'
) {
    throw 'Knowledge-base embedding model must use provider:model format, for example openai:text-embedding-3-small.'
}

$PublicBaseUrl = Resolve-PublicBaseUrl -Value $PublicBaseUrl -HostPort $Port

$accessCode = Get-EnvValue -Content $envContent -Name 'ACCESS_CODE'
if ($accessCode -notmatch '^[A-Za-z0-9._-]{1,128}$') {
    $accessCode = New-RandomHex -ByteCount 24
}

$integrationSecret = Get-EnvValue -Content $envContent -Name 'INTEGRATION_SHARED_SECRET'
if ([string]::IsNullOrWhiteSpace($integrationSecret)) {
    $integrationSecret = New-RandomHex -ByteCount 32
}

$databasePassword = Get-EnvValue -Content $envContent -Name 'PERSISTENCE_POSTGRES_PASSWORD'
if ([string]::IsNullOrWhiteSpace($databasePassword)) {
    $existingDatabaseUrl = Get-EnvValue -Content $envContent -Name 'DATABASE_URL'
    $databaseUrlMatch = [regex]::Match(
        $existingDatabaseUrl,
        '^[a-zA-Z][a-zA-Z0-9+.-]*://[^:/@]+:([^@/]*)@'
    )
    if ($databaseUrlMatch.Success -and -not [string]::IsNullOrWhiteSpace($databaseUrlMatch.Groups[1].Value)) {
        $databasePassword = [Uri]::UnescapeDataString($databaseUrlMatch.Groups[1].Value)
    }
}
if ([string]::IsNullOrWhiteSpace($databasePassword)) {
    $databasePassword = New-RandomHex -ByteCount 24
}
$encodedDatabasePassword = [Uri]::EscapeDataString($databasePassword)
$databaseUrl = "postgres://openmaic:$encodedDatabasePassword@postgres:5432/openmaic"

$existingModelRoutes = Get-EnvValue -Content $envContent -Name 'MODEL_ROUTES'
$modelRoutes = Merge-ModelRoutes -Json $existingModelRoutes -ModelId $ModelId

Write-Step 'Writing .env.local'
$envContent = Set-EnvValue -Content $envContent -Name 'OPENAI_API_KEY' -Value $apiKey
$envContent = Set-EnvValue -Content $envContent -Name 'OPENAI_BASE_URL' -Value $ModelBaseUrl
$envContent = Set-EnvValue -Content $envContent -Name 'OPENAI_MODELS' -Value $ModelId
$envContent = Set-EnvValue -Content $envContent -Name 'DEFAULT_MODEL' -Value "openai:$ModelId"
$envContent = Set-EnvValue -Content $envContent -Name 'MODEL_ROUTES' -Value $modelRoutes
$envContent = Set-EnvValue -Content $envContent -Name 'DATABASE_URL' -Value $databaseUrl
$envContent = Set-EnvValue -Content $envContent -Name 'PERSISTENCE_POSTGRES_PASSWORD' -Value $databasePassword
$envContent = Set-EnvValue -Content $envContent -Name 'NEXT_PUBLIC_PERSISTENCE' -Value '1'
$envContent = Set-EnvValue -Content $envContent -Name 'NEXT_PUBLIC_PRO_WORKBENCH_ENABLED' -Value 'true'
$envContent = Set-EnvValue -Content $envContent -Name 'OPENMAIC_AGENT_RUNTIME_ENABLED' -Value 'true'
$envContent = Set-EnvValue -Content $envContent -Name 'OPENMAIC_SINGLE_GAME_MODE' -Value 'true'
$envContent = Set-EnvValue -Content $envContent -Name 'PERSISTENCE_SHARED_OWNER_ID' -Value 'openmaic-shared'
$envContent = Set-EnvValue -Content $envContent -Name 'PERSISTENCE_SHARED_OWNER_ALLOW_OPEN' -Value 'true'
$envContent = Set-EnvValue -Content $envContent -Name 'KNOWLEDGE_BASE_EMBEDDING_MODEL' -Value $KnowledgeEmbeddingModel
$envContent = Set-EnvValue -Content $envContent -Name 'ACCESS_CODE' -Value $accessCode
$envContent = Set-EnvValue -Content $envContent -Name 'INTEGRATION_SHARED_SECRET' -Value $integrationSecret
$envContent = Set-EnvValue -Content $envContent -Name 'INTEGRATION_PUBLIC_BASE_URL' -Value $PublicBaseUrl
$envContent = Set-EnvValue -Content $envContent -Name 'OPENMAIC_BASE_URL' -Value $PublicBaseUrl
$envContent = Set-EnvValue -Content $envContent -Name 'OPENMAIC_HOST_PORT' -Value ([string]$Port)
$cookieSecure = if (([Uri]$PublicBaseUrl).Scheme -eq 'https') { '1' } else { '0' }
$envContent = Set-EnvValue -Content $envContent -Name 'COOKIE_SECURE' -Value $cookieSecure

$utf8NoBom = New-Object System.Text.UTF8Encoding($false)
[System.IO.File]::WriteAllText($EnvPath, $envContent, $utf8NoBom)

Write-Host "Configuration written to: $EnvPath"
Write-Host "LAN URL: $PublicBaseUrl"
Write-Host "Access code: $accessCode"
Write-Host ''
Write-Host 'Optional provider capabilities are configured in .env.local (or server-providers.yml):'
Write-Host '  custom MODEL_ROUTES, vision OCR, TTS, ASR, image, video, web search, PDF services.'
Write-Host '  The installer preserves existing MODEL_ROUTES entries and only updates maic-agent-driver.'
Write-Host '  See DEPLOY.md section 4.4 before enabling any optional capability.'

if ($SkipStart) {
    Write-Step 'Configuration complete'
    Write-Host 'Service start was skipped because -SkipStart was supplied.'
    exit 0
}

Push-Location $RepoRoot
try {
    Write-Step 'Validating Docker Compose configuration'
    & docker compose --env-file $EnvPath --profile server-persistence config --quiet
    if ($LASTEXITCODE -ne 0) {
        throw 'Docker Compose rejected the generated configuration.'
    }

    Write-Step 'Building and starting OpenMAIC'
    Write-Host 'The first build can take several minutes.'
    & docker compose --env-file $EnvPath --profile server-persistence up -d --build
    if ($LASTEXITCODE -ne 0) {
        throw 'Docker Compose failed to start OpenMAIC.'
    }

    Write-Step 'Waiting for OpenMAIC to become healthy'
    if (-not (Wait-ForHealth -HostPort $Port)) {
        & docker compose --env-file $EnvPath --profile server-persistence logs --tail=120 openmaic
        throw "OpenMAIC did not become healthy within ten minutes. Review the container logs above."
    }
}
finally {
    Pop-Location
}

Write-Host ""
Write-Host 'OpenMAIC is running.' -ForegroundColor Green
Write-Host "URL: $PublicBaseUrl"
Write-Host "Access code: $accessCode"
Write-Host "Integration secret: stored in $EnvPath"
Write-Host ''
Write-Host 'The integration secret is server-to-server only. Do not put it in a browser or frontend bundle.'
Write-Host "If Windows Firewall prompts, allow TCP port $Port on the private network."
