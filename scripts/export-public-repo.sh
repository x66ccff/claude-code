#!/usr/bin/env bash
set -Eeuo pipefail

source_root=$(git rev-parse --show-toplevel)
target=${1:-"$(dirname "$source_root")/claude-code-best-public"}
target=$(realpath -m "$target")
marker=.public-export-managed

if ! git -C "$source_root" diff --quiet || \
   ! git -C "$source_root" diff --cached --quiet; then
    echo 'public export: source repository must be clean and committed' >&2
    exit 2
fi

case "$target/" in
    "$source_root/"|"$source_root/"*)
        echo 'public export: target must be outside the source repository' >&2
        exit 2
        ;;
esac

if [[ -e "$target" && ! -f "$target/$marker" ]]; then
    echo "public export: refusing to update unmarked target: $target" >&2
    exit 2
fi

stage=$(mktemp -d)
trap 'rm -rf -- "$stage"' EXIT

# git archive honors .gitattributes export-ignore and carries no source Git
# history, reflogs, remotes, author email, ignored files, or untracked files.
git -C "$source_root" archive --format=tar HEAD | tar -xf - -C "$stage"

if [[ ! -d "$target/.git" ]]; then
    mkdir -p "$target"
    git -C "$target" init -b main >/dev/null
fi

rsync -a --delete --exclude='.git/' "$stage/" "$target/"
git -C "$target" add -A

PUBLIC_AUDIT_DENY_FILE=${PUBLIC_AUDIT_DENY_FILE:-"$source_root/.public-export-local-patterns"} \
    "$target/scripts/audit-public-tree.sh" "$target"

printf 'public export: staged sanitized snapshot in %s\n' "$target"
printf 'public export: review git -C %q diff --cached before committing\n' "$target"
