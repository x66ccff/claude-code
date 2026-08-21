#!/usr/bin/env bash
set -Eeuo pipefail

root=${1:-.}
root=$(realpath "$root")

if ! git -C "$root" rev-parse --is-inside-work-tree >/dev/null 2>&1; then
    printf 'public audit: %s is not a Git working tree\n' "$root" >&2
    exit 2
fi

failures=0

report_paths() {
    local heading=$1
    shift
    local matches
    matches=$("$@" || true)
    if [[ -n "$matches" ]]; then
        printf 'public audit: %s\n%s\n' "$heading" "$matches" >&2
        failures=$((failures + 1))
    fi
}

tracked_private_paths() {
    git -C "$root" ls-files | \
        rg '^(\.claude|\.codex|\.agents)/|(^|/)(credentials\.json|\.env($|\.)|[^/]+\.(pem|p12|pfx))$' | \
        rg -v '^(\.claude/agents/hello-agent\.md|\.claude/skills/interview/SKILL\.md|\.claude/skills/teach-me/SKILL\.md|\.claude/skills/teach-me/references/pedagogy\.md)$'
}

credential_paths() {
    local file line content token
    git -C "$root" grep -InE "$secret_pattern" -- . 2>/dev/null | \
        while IFS=: read -r file line content; do
            while IFS= read -r token; do
                # AWS publishes this exact value as a non-secret example in
                # SDK documentation and tests. Do not allowlist its file: a
                # second, real credential in the same file must still fail.
                [[ "$token" == 'AKIAIOSFODNN7EXAMPLE' ]] && continue
                printf '%s\n' "$file"
            done < <(printf '%s' "$content" | grep -oE "$secret_pattern")
        done | sort -u
}

# User-installed agents, skills, plugins, and runtime state belong outside the
# public mirror even if they were accidentally force-added in the source repo.
report_paths 'private agent/runtime paths are tracked' \
    tracked_private_paths

# Match credential formats tightly enough to avoid ordinary source identifiers
# such as task-budget beta names. Only filenames are printed, never matches.
secret_pattern='sk-or-v1-[0-9A-Fa-f]{48,}|sk-ant-api[0-9]*-[A-Za-z0-9_-]{48,}|sk-proj-[A-Za-z0-9_-]{32,}|github_pat_[A-Za-z0-9_]{16,}|gh[pousr]_[A-Za-z0-9]{24,}|AKIA[0-9A-Z]{16}|AIza[0-9A-Za-z_-]{30,}|xox[baprs]-[0-9A-Za-z-]{20,}|-----BEGIN (RSA |EC |OPENSSH )?PRIVATE KEY-----'
report_paths 'credential-shaped content found (filenames only)' \
    credential_paths

# A private source checkout can provide exact local-only strings without
# committing those strings. This catches usernames, hostnames, model paths,
# ports, or other machine identifiers that generic secret regexes cannot know.
deny_file=${PUBLIC_AUDIT_DENY_FILE:-}
if [[ -n "$deny_file" && -r "$deny_file" ]]; then
    while IFS= read -r literal; do
        [[ -z "$literal" || "$literal" == \#* ]] && continue
        report_paths 'machine-local marker found (filenames only)' \
            git -C "$root" grep -IlF -e "$literal" -- .
    done <"$deny_file"
fi

if (( failures > 0 )); then
    printf 'public audit: failed with %d finding group(s)\n' "$failures" >&2
    exit 1
fi

printf 'public audit: passed (%s)\n' "$root"
