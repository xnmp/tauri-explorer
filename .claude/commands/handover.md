---
description: Generate a handover document for the next session
argument-hint: <focus for next session>
allowed-tools: Read, Glob, Bash(git status:*), Bash(git diff:*), Bash(git log:*)
---

# Session Handover Document

Generate a concise handover document that I can paste as the opening prompt in a new Claude Code session.

**Next session's focus:** $ARGUMENTS

## Information to Include

1. **What We Worked On** - Brief summary of the main tasks/features from this session
2. **Key Decisions Made** - Important architectural, design, or implementation choices  
3. **Current State** - Where things stand now (what's working, what's broken, what's in progress)
4. **Relevant Context for Next Session** - Filter what you include based on the stated focus above. Only include details that are relevant to "$ARGUMENTS"

## Context to Gather

- Recent git activity: !`git log --oneline -10 2>/dev/null || echo "No git history"`
- Current status: !`git status --short 2>/dev/null || echo "Not a git repo"`
- Uncommitted changes: !`git diff --stat 2>/dev/null | tail -5 || echo "No changes"`

## Output

Write the handover document to `docs/HANDOVER.md`. Structure it like:

```
Continuing work on [focus area].

**Previous session summary:** [1-2 sentences]

**Key context:**
- [relevant point]
- [relevant point]

**Current state:** [what's working/broken/in-progress]

**Next steps:** [what to do now]
```

Keep it focused and actionable. Only include details relevant to the next session's focus.