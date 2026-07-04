<!--
  GitGraphView — pane content for a git-graph tab (#51/#56).
  Placeholder until the graph renderer lands (#58); the tagged-union tab
  plumbing (open/persist/restore/close) is fully live behind it.
-->
<script lang="ts">
  const { repoPath }: { repoPath: string } = $props();
</script>

<div class="git-graph-view" data-testid="git-graph-view">
  <svg width="48" height="48" viewBox="0 0 24 24" fill="none" aria-hidden="true">
    <circle cx="6" cy="5" r="2.2" stroke="currentColor" stroke-width="1.5" />
    <circle cx="6" cy="19" r="2.2" stroke="currentColor" stroke-width="1.5" />
    <circle cx="17" cy="5" r="2.2" stroke="currentColor" stroke-width="1.5" />
    <path
      d="M6 7.2v9.6M17 7.2v2.3c0 2.6-2.2 3.8-5.2 3.8H8.2"
      stroke="currentColor"
      stroke-width="1.5"
      stroke-linecap="round"
    />
  </svg>
  <h2>Git graph</h2>
  <p class="repo">{repoPath}</p>
  <p class="hint">Commit graph rendering is coming with #58.</p>
</div>

<style>
  .git-graph-view {
    flex: 1;
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    gap: 8px;
    color: var(--text-tertiary);
    background: var(--background-card);
  }

  h2 {
    margin: 0;
    font-size: 15px;
    font-weight: 600;
    color: var(--text-secondary);
  }

  .repo {
    margin: 0;
    font-size: 12px;
    font-family: var(--font-mono, monospace);
  }

  .hint {
    margin: 0;
    font-size: 12px;
  }
</style>
