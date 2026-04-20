<!--
  ScmSidebarView - Source Control activity-bar view.
  Skeleton in #52; filled in by #54 (SCM panel UI).
-->
<script lang="ts">
</script>

<div class="sidebar-view scm-view">
  <div class="empty-state">
    <div class="empty-title">Source Control</div>
    <div class="empty-hint">Coming soon.</div>
  </div>
</div>

<style>
  .sidebar-view {
    display: flex;
    flex-direction: column;
    height: 100%;
    overflow-y: auto;
  }

  .empty-state {
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    padding: 48px 16px;
    text-align: center;
    color: var(--text-secondary);
    gap: 8px;
  }

  .empty-title {
    font-size: 13px;
    font-weight: var(--font-weight-semibold);
    color: var(--text-primary);
  }

  .empty-hint {
    font-size: 12px;
    color: var(--text-tertiary);
  }
</style>
