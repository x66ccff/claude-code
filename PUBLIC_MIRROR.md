# Public mirror

This repository is a sanitized source snapshot maintained separately from a
machine-private runtime checkout. It contains generic implementation changes
for custom OpenAI-compatible models, context and cache observability, configurable
web adapters and proxies, project `AGENTS.md` discovery, and more robust stream,
compaction, and shutdown cancellation.

The mirror intentionally does not contain:

- API keys, credentials, model weights, or local settings;
- user-installed `.claude`, `.codex`, or `.agents` content;
- machine-specific launchers, paths, hosts, ports, Docker recipes, or model
  profiles;
- source-checkout Git history or release credentials.

Runtime-specific values should be supplied through environment variables or
untracked settings. See `docs/public-repository-maintenance.md` for the export,
audit, provenance, and licensing workflow.

The codebase originates from the reverse-engineered Claude Code Best project:
<https://github.com/claude-code-best/claude-code>. Review that project's status
and applicable vendor terms before redistribution.
