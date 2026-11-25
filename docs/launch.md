# Which Git worktree did your MCP tool actually read?

I switched a Codex thread from worktree A to B and asked its filesystem tool to read `src/probe.ts`. It returned A’s copy. I had deliberately left the server pointed at A. After I corrected its root and reloaded it, the same thread made the same call and got B’s copy.

[Watch the 20-second demo](https://github.com/remnate/whichtree/blob/main/media/worktree-switch.gif) or [run it locally](https://github.com/remnate/whichtree#run-from-a-checkout). WhichTree creates two temporary worktrees and an isolated server registration. The demo runs on Linux with Codex CLI 0.171.0 and needs no API key.

If you use Git worktrees with MCP, try the demo on your machine. Which host and tool would you want to check in your own setup? [Share your setup on GitHub](https://github.com/remnate/whichtree/issues).

## Pilot

Invite four client integrators, three index maintainers and three parallel-worktree users in moderator-approved project discussions. Ask each to try the pinned filesystem recipe on a host installation they maintain and return the sanitized JSON, the command, and any inconclusive step. Keep private traces on the pilot's machine.

Count a participant once they confirm a local run. Track the host and tool versions, the number of reproducible sequences and the number of upgrades checked. For the next 90 users, offer participating maintainers a small fixture and a pinned troubleshooting recipe they can link from their own docs. Fund a second host adapter only after two independent teams rerun on an upgrade.

## Context

A reported Metals lookup discrepancy motivated checking returned content. A CodeGraph fix illustrates how a cached path warning can mislead. These historical reports supply context for the control case. [Claude Code report](https://github.com/anthropics/claude-code/issues/98822) · [CodeGraph fix](https://github.com/colbymchenry/codegraph/pull/939)

A fresh session with an explicitly selected checkout may already serve a team's needs. Serena has received worktree detection improvements, and ctxpilot supports worktree handoffs. WhichTree v0.1 measures file content across a retained Codex thread and a cold process. Symbol bodies and additional hosts need separate adapter runs. [Serena contribution](https://github.com/oraios/serena/pull/1550) · [ctxpilot](https://github.com/eldarjobs/ctxpilot/blob/cc2c7851414a91838b7f4acc2c5fd60c8d8b33a6/README.md)

