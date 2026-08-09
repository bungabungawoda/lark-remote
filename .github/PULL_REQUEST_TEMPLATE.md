name: Pull Request
about: Submit a pull request for lark-remote
---

## Description

<!-- What does this PR do? Link any relevant issues. -->

Fixes #

## Checklist

- [ ] I have read the [Contributing Guide](CONTRIBUTING.md)
- [ ] `bun run typecheck` passes
- [ ] `bun run test` passes
- [ ] New code includes appropriate tests
- [ ] For CardKit 2.0 card changes: 200861 regression test passes
  (`expect(json).not.toMatch(/"tag"\s*:\s*"action"[^}]*"actions"/)`)
