---
description: "Show the CLAUDE.md block that exempts EmbArch's build tool from a never-build-autonomously rule, and add it only on a yes"
category: "Repo setup"
disable-model-invocation: true
---

Offer to add EmbArch's block to the open repo's `CLAUDE.md`, and write it only when I say yes.

The block (suite/user-guide.md §7.1):

```markdown
<!-- embarch:begin -->
Never build firmware or flash devices autonomously — ask me to run it.
  Exception: builds routed through EmbArch's `build` tool, which uses its own
  build directory and can't disturb my interactive build tree.
<!-- embarch:end -->
```

Why it exists: a stray `west build` can blow away a hand-made build tree, so many firmware repos forbid autonomous builds, and then the agent keeps asking even for EmbArch's `build`, which cannot collide with it. Flashing still asks, through the permission split (`/embarch-permissions`).

Steps:
1. Read the repo's `CLAUDE.md` (root, or `.claude/CLAUDE.md` if that is the one in use). If an `embarch:begin` block is already there, show it, say whether it differs from the one above, and stop unless I ask to update it.
2. If the file already has its own "never build / never flash" rule, propose adding only the two Exception lines directly under that rule, inside the markers, rather than a second copy of the rule. Otherwise propose appending the whole block at the end.
3. Show the exact diff. Write only on my yes, and never rewrite or reflow anything else in the file. If there is no `CLAUDE.md`, ask before creating one.
4. `CLAUDE.md` is usually tracked, so the team sees the change on the next commit: if the repo is not mine, offer `CLAUDE.local.md` instead.
