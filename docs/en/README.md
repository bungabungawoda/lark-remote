# lark-remote Documentation (English)

中文文档：[../zh/README.md](../zh/README.md)

Browse by topic:

## Getting Started

- [**getting-started.md**](getting-started.md) — Beginner-friendly guide: from zero to running + basic maintenance.

## Daily Use

- [**usage.md**](usage.md) — Complete usage guide: installation, configuration, all commands, workflow examples, troubleshooting.

## Architecture & Design

- [architecture/design.md](architecture/design.md) — Overall design, JSONL events, config semantics, §9 known pitfalls (the most important design document).
- [architecture/lessons-redlines.md](architecture/lessons-redlines.md) — Red lines & pitfall knowledge base (full version of the CLAUDE.md summary).
- [architecture/streaming-card.md](architecture/streaming-card.md) — Single-card streaming architecture (RunCardSession / BashCardSession lifecycle, degradation, concurrency control).
- [cardkit-layout.md](cardkit-layout.md) — Feishu CardKit 2.0 card layout pitfall guide.

## Guides

- [guides/add-new-agent.md](guides/add-new-agent.md) — 10-step template for integrating a new AI agent (registry pattern).
- [guides/codex-config.md](guides/codex-config.md) — How Codex fields in the `/config` card work; provider/model switching linkage.
- [guides/open-source-playbook.md](guides/open-source-playbook.md) — Open-source release, npm publishing SOP, maintenance SOP, promotion channels & copy.

## External Reference

- [Feishu CardKit 2.0 component official docs](https://open.feishu.cn/document/feishu-cards/card-json-v2-components/component-json-v2-overview) — Buttons, inputs, collapsible panels, etc.

## Root-level Docs

- [../../README.en.md](../../README.en.md) — Project overview (install / run / command reference).
- [../../CLAUDE.md](../../CLAUDE.md) — AI collaboration rules, command cheat sheet, architecture layers, red lines & pitfalls, doc pointers. **Required reading before code changes**.

## Maintenance Conventions

- Path stability: `architecture/design.md` §9.x section numbers are anchors referenced from CLAUDE.md — **do not renumber**.
- Historical archival: patterns no longer in the codebase are deleted outright, not kept in a "historical archive" section; incident post-mortems go into git commit messages or PR descriptions.
- New docs: place in the appropriate subdirectory (architecture/guides/) and add a pointer in both this README and the CLAUDE.md "Deep docs" table.
- Do not write session-level changelogs into CLAUDE.md; CLAUDE.md is a rulebook, not a change log.
