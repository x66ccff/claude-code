# Local OpenAI-compatible model adapters

The shared Claude Code build supports local models through generic provider and
capability switches. Model service lifecycle and model-specific protocol quirks
must stay outside the generic UI and cloud-provider paths.

## Boundaries

- `src/services/api/openai/` owns OpenAI-compatible request construction,
  streaming, serialization gates, and generic reasoning-effort forwarding.
- `packages/@ant/model-provider/src/shared/openaiStreamAdapter.ts` normalizes
  provider response dialects into Claude stream events. It accepts both the
  common `delta.reasoning_content` field and vLLM's `delta.reasoning` alias and
  emits native `thinking` / `thinking_delta` events for the shared UI.
  When available, it also normalizes
  `completion_tokens_details.reasoning_tokens` to `usage.thinking_tokens`;
  the turn summary otherwise displays an explicitly marked estimate computed
  from received thinking blocks.
- `src/utils/context.ts`, `src/utils/effort.ts`, and the model picker own generic
  context/capability/effort behavior. They must not contain model names, Docker
  assumptions, cluster addresses, or model paths.
- A `claude-local` profile owns endpoint lifecycle, runtime/image/script,
  topology, model ID, safety limits, isolated config, and process-local env.
- Serving recipes/mods own chat templates, native reasoning prefixes, tool-call
  templates, and parsers when these are model-specific.

Useful process-local controls include:

- `OPENAI_DEFAULT_OPUS_MODEL` and
  `OPENAI_DEFAULT_OPUS_MODEL_SUPPORTED_CAPABILITIES`
- `CLAUDE_CODE_MAX_CONTEXT_TOKENS`, `OPENAI_MAX_TOKENS`, and
  `CLAUDE_CODE_AUTO_COMPACT_WINDOW`
- `CLAUDE_CODE_MODEL_PICKER_EFFORT_LEVELS`,
  `CLAUDE_CODE_DEFAULT_EFFORT_LEVEL`, and
  `CLAUDE_CODE_ALLOW_PERSIST_MAX_EFFORT`
- `OPENAI_ENABLE_THINKING`, `CLAUDE_CODE_OPENAI_SERIAL_REQUESTS`, and
  `CLAUDE_CODE_OPENAI_LOCAL_ZERO_COST`

Claude Code's canonical effort domain is `low`, `medium`, `high`, `xhigh`, and
`max`. A model with different labels should map those labels at its profile or
serving adapter boundary. Extend the shared effort type only if the semantics
cannot be represented by a mapping, and update model picker, persistence,
request-body, capability, and provider tests together.

## Project instruction discovery

`src/utils/claudemd.ts` treats `AGENTS.md` as checked-in Project memory alongside
`CLAUDE.md`. Both are discovered root-to-CWD at startup and CWD-to-target when a
tool first reaches a deeper directory. The common processing path provides
deduplication, `@include`, exclusion patterns, and instruction-loaded hooks.

Preserve the per-directory compatibility order:

1. `CLAUDE.md`
2. `AGENTS.md`
3. `.claude/CLAUDE.md`
4. `.claude/rules/*.md`
5. `CLAUDE.local.md`

Deeper directories are loaded later and therefore have higher priority. The
legacy `claudeMdExcludes` setting also applies to `AGENTS.md`; do not rename it
without a backward-compatible migration.

## Change checklist

1. Add a new local profile rather than editing shared cloud routing.
2. Capability-gate context, effort, thinking, or tool behavior.
3. Verify tool-call serialization/parsing with the actual serving template.
4. Run targeted provider/instruction tests, `bun run typecheck`, and
   `bun run build`.
5. Smoke-test both `claude` and `claude-local`, and compare cloud settings hashes
   before and after the local run.
