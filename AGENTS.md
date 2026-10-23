# Cheat on Content Workbench

This repository is a visual-interface fork of upstream Cheat on Content. Preserve the upstream skills, references, templates, adapters and license. Add the application under `apps/workbench/`.

The user explicitly authorizes the complete upstream workflow including topics and drafting for this new application; old restrictions in the parent content project do not define this fork's product scope. Do not import or modify the parent's actual creator files or credentials.

Upstream-compatible workspace files are the source of truth: scripts, predictions, videos, rubric_notes.md and .cheat-state.json. Application metadata is additive. Do not replace the framework with a disconnected mock dashboard. Demo records must be clearly labeled and isolated from owner records.

Blind scoring uses the CodeBuddy main agent delegating exactly one `cheat-blind-reviewer` sub-agent through the built-in `Agent` tool. The sub-agent receives only the frozen draft and clean rubric; the main agent only schedules. The server verifies the completed tool call and reads the score from its tool result — never accept the main agent's own score. Never use collaboration agents to score content. Collaboration agents may implement/review code. Preserve predictions, versions and honest task/error states.

Read secrets only in the application runtime when necessary; never print or persist credential values in source, reports, browser responses or screenshots. No automatic publishing to social platforms.
