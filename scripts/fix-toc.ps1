$path = "c:\Repos\Personal\ChatWizard\docs\user-guide.md"
$raw = Get-Content $path -Raw
$lines = $raw -split "`n"

# Fix TOC numbering in the TOC region (lines 50-85, 0-indexed)
$fixes = @{
    '11. [MCP Server' = '10. [MCP Server'
    '12. [REST API' = '11. [REST API'
    '13. [Cloud Sync' = '12. [Cloud Sync'
    '14. [Workspace Digest' = '13. [Workspace Digest'
    '15. [Post-Session Cost' = '14. [Post-Session Cost'
    '16. [Workspace' = '15. [Workspace'
    '17. [Session Lifecycle' = '16. [Session Lifecycle'
    '18. [AI Intelligence' = '17. [AI Intelligence'
    '19. [Keyboard Navigation' = '18. [Keyboard Navigation'
    '20. [Did You Know' = '19. [Did You Know'
    '21. [Settings Reference' = '20. [Settings Reference'
    '22. [Commands Reference' = '21. [Commands Reference'
    '23. [Quick Reference' = '22. [Quick Reference'
}

for ($i=0; $i -lt $lines.Count; $i++) {
    foreach ($old in $fixes.Keys) {
        if ($lines[$i] -match [regex]::Escape($old)) {
            $lines[$i] = $lines[$i] -replace [regex]::Escape($old), $fixes[$old]
            break
        }
    }
}

# Fix anchor links throughout the document
$anchorFixes = @{
    '(#11-mcp-server' = '(#10-mcp-server'
    '(#12-rest-api' = '(#11-rest-api'
    '(#13-cloud-sync' = '(#12-cloud-sync'
    '(#14-workspace-digest' = '(#13-workspace-digest'
    '(#15-post-session-cost' = '(#14-post-session-cost'
    '(#16-workspace-&amp;-file' = '(#15-workspace-&amp;-file'
    '(#17-session-lifecycle' = '(#16-session-lifecycle'
    '(#18-ai-intelligence' = '(#17-ai-intelligence'
    '(#19-keyboard-navigation' = '(#18-keyboard-navigation'
    '(#20-did-you-know' = '(#19-did-you-know'
    '(#21-settings-reference' = '(#20-settings-reference'
    '(#22-commands-reference' = '(#21-commands-reference'
    '(#23-quick-reference' = '(#22-quick-reference'
}

for ($i=0; $i -lt $lines.Count; $i++) {
    foreach ($old in $anchorFixes.Keys) {
        if ($lines[$i] -match [regex]::Escape($old)) {
            $lines[$i] = $lines[$i] -replace [regex]::Escape($old), $anchorFixes[$old]
            break
        }
    }
}

$lines -join "`r`n" | Set-Content $path -Encoding UTF8 -NoNewline
Write-Output "Done"