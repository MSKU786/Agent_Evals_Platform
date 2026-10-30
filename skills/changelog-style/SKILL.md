---
name: changelog-style
description: Write changelog entries in this project's house format. Use whenever asked to produce a changelog, release notes, or "what changed" summary.
version: 1.0.0
author: Agent Evals Platform
license: MIT
platforms: [linux, macos, windows]
metadata:
  hermes:
    tags: [Writing, Changelog, House-Style]
---

# Changelog house format

When asked to write a changelog, you MUST follow these rules exactly. They are
deliberately specific so that a grader can check whether the skill was applied.

1. Start with a single line header: `## Changelog`
2. Group entries under exactly these three headings, in this order, and only
   include a heading if it has at least one entry:
   - `### Added`
   - `### Fixed`
   - `### Changed`
3. Every entry is a bullet beginning with `- ` and written in the imperative
   mood (e.g. "Add", "Fix", "Change"), ending with a period.
4. End the document with the footer line: `_Generated in house format._`

Do not add any other sections, prose, or commentary. Output only the changelog.
