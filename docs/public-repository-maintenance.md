# Public repository maintenance

This source checkout may coexist with machine-private launchers, API settings,
skills, plugins, and model profiles. Do not push the private checkout directly.
Generate a separate public mirror instead:

```bash
scripts/export-public-repo.sh ../claude-code-best-public
git -C ../claude-code-best-public diff --cached
git -C ../claude-code-best-public commit -m "chore: publish sanitized snapshot"
```

The export uses `git archive`, so the mirror receives the committed source tree
without the source repository's history, reflogs, remotes, ignored files, or
author email. `.gitattributes` also excludes `.claude/`, `.codex/`, `.agents/`,
credential files, and the optional local deny list.

## Machine-specific deny list

Create `.public-export-local-patterns` in the private checkout, one literal per
line. It is ignored and excluded from archives. Suitable entries include local
user paths, hostnames, LAN addresses, proxy endpoints, and model directories.
Do not add active API keys to this file; the generic credential scanner already
detects common key formats without storing a second copy of a secret.

## Updating the public mirror

Commit and test private source changes first, then run the same export command.
An existing target is updated only when it contains `.public-export-managed`;
this prevents `rsync --delete` from touching an unrelated directory. Review the
staged diff, run the normal checks, commit with a GitHub noreply email, and push
from the public mirror only.

The mirror intentionally has no source remote. Add the destination only after
creating an empty GitHub repository:

```bash
git -C ../claude-code-best-public remote add origin git@github.com:OWNER/REPO.git
git -C ../claude-code-best-public push -u origin main
```

## License and provenance

Secret scanning answers only whether the snapshot contains private data. It
does not grant redistribution rights. At the time this workflow was added, the
source tree did not contain a root `LICENSE` file and describes itself as
reverse-engineered/decompiled software. Before making a GitHub repository
public, verify the upstream project's license and the applicable vendor terms,
and add only a license or notice that you are legally entitled to apply.

The public export excludes npm/release workflows that rely on repository
secrets. Generic CI and the public safety audit remain enabled.
